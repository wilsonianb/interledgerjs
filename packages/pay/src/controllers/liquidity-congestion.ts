import { StreamController, StreamRequest, StreamReply, ControllerMap, NextRequest } from '.'
import { IlpError } from 'ilp-packet'
import { Int, PositiveInt, Ratio, NonNegativeNumber, PositiveRatio } from '../utils'
import { PendingRequestTracker } from './pending-requests'
import createLogger from 'ilp-logger'
import { sleep } from '../utils'

/**
 * TODO issues
 *
 * - doesn't work well with max packet amounts close to throughput limit
 * - how to identify correct parameters?
 */

// TODO When competing senders use different maxPacketAmount/initialWindowSize,
//      this gets very unfair (10x throughput difference)
export class SimpleCongestionController implements StreamController {
  private readonly defaultWindowSize: PositiveInt
  private congestionWindow: PositiveInt
  private nextBackoff = 0
  private amountInFlight = Int.ZERO

  private static DECREASE_FACTOR = Ratio.from(0.5 as NonNegativeNumber) as PositiveRatio

  constructor(initialWindow: PositiveInt) {
    this.defaultWindowSize = initialWindow
    this.congestionWindow = initialWindow
  }

  getRemainingInWindow(): Int {
    return this.congestionWindow.subtract(this.amountInFlight)
  }

  nextState(_: NextRequest, controllers: ControllerMap): Promise<void> | void {
    if (!this.getRemainingInWindow().isPositive()) {
      // Cancel the packet if no bandwidth is available
      return Promise.race(controllers.get(PendingRequestTracker).getPendingRequests())
    }
  }

  applyRequest({ sourceAmount, log }: StreamRequest): (reply: StreamReply) => void {
    this.amountInFlight = this.amountInFlight.add(sourceAmount)
    log.debug('window size: %s', this.congestionWindow) // TODO Remove

    return (reply: StreamReply) => {
      this.amountInFlight = this.amountInFlight.subtract(sourceAmount)

      // Multiplicatively backoff up to once per RTT
      const shouldBackoff =
        reply.isReject() &&
        reply.ilpReject.code === IlpError.T04_INSUFFICIENT_LIQUIDITY &&
        Date.now() > this.nextBackoff // Only allow backing off once per RTT
      if (shouldBackoff) {
        this.congestionWindow = this.congestionWindow
          .multiplyFloor(SimpleCongestionController.DECREASE_FACTOR)
          .orGreater(this.defaultWindowSize)
        this.nextBackoff = Date.now() + 200 // TODO RTT estimate?
      }
      // When amounts get through to the recipient, increase the window size.
      // This has the net effect of doubling the window size once per RTT (approx)
      else if (reply.isAuthentic()) {
        this.congestionWindow = this.congestionWindow.add(sourceAmount)
      }
    }
  }
}

enum Outcome {
  Ack,
  LiquidityError,
}

export class CongestionController implements StreamController {
  /** Requests, ordered oldest to most recent */
  private requests: {
    type: Outcome
    amount: number
    timestamp: number
  }[] = []

  private amountInFlight = Int.ZERO

  nextState(_: NextRequest, controllers: ControllerMap): Promise<void> | void {
    this.pruneWindow() // TODO Do this more frequently

    if (!this.getRemainingInWindow().isPositive()) {
      // Cancel the packet if no bandwidth is available
      return Promise.race([
        sleep(5), // TODO Could this estimate when the available amount will be above a certain threshold?
        ...controllers.get(PendingRequestTracker).getPendingRequests(),
      ])
    }
  }

  // TODO Use most recent n requests for bandwidth *limit*,
  //      but use time for utilized bandwidth?

  /** Estimated limit on the available liquidity bandwidth, in source units per millisecond */
  estimateBandwidthLimit(): number | undefined {
    const latestRequests = this.requests.slice().reverse()

    // TODO Would a slower ramp up prevent stealing bandwidth from competing senders?

    // Until a T04 is hit, assume there's no limit on the available bandwidth:
    // it must be discovered through explicit notifications of congestion
    const liquidityErrorIndex = latestRequests.findIndex(
      (req) => req.type === Outcome.LiquidityError
    )
    const latestLiquidityError = latestRequests[liquidityErrorIndex]
    if (!latestLiquidityError) {
      return
    }

    // TODO Is there a way to do this more efficiently so it doesn't need to happen every `nextState`?

    // Compute the total amount acknowledged in the window before the most recent T04 error
    const totalAckedBeforeError = latestRequests
      .slice(liquidityErrorIndex)
      .filter((req) => req.type === Outcome.Ack)
      .reduce((total, req) => total + req.amount, 0)
    // Add the amount that triggered the T04 to estimate a limit on the available bandwidth over that duration
    // total amount we've been able to get through, plus the amount that failed
    // TODO How would simultaneous in-flight packets affect this?

    // TODO 0.667 decrease, (1 / 0.667) increase seemed to work decently well for competing senders
    const totalAmount =
      (totalAckedBeforeError + latestLiquidityError.amount) * 0.5 +
      latestRequests
        .slice(0, liquidityErrorIndex)
        .filter((req) => req.type === Outcome.Ack)
        .reduce((total, req) => total + req.amount, 0) *
        2 // TODO what should these constants be?

    const duration = latestRequests[0].timestamp - this.requests[0].timestamp

    const limit = totalAmount / duration // TODO What if duration is 0?
    createLogger('congestion').debug('limit: %s', limit)

    return limit
  }

  getRemainingInWindow(): Int {
    const bandwidthLimit = this.estimateBandwidthLimit()
    if (!bandwidthLimit) {
      return Int.MAX_U64 // TODO
    }

    // TODO Does this make sense?

    const windowDuration = Date.now() - this.requests[0].timestamp
    const amountLimitInWindow = Math.floor(windowDuration * bandwidthLimit)
    createLogger('congestion').debug('windowLimit: %s', amountLimitInWindow)

    // TODO only tracks utilized in the most recent 3 seconds
    const now = Date.now()
    const amountUtilizedInWindow =
      this.requests
        .filter((req) => req.type === Outcome.Ack && req.timestamp > now - 3000)
        .reduce((total, req) => total + req.amount, 0) + this.amountInFlight.toNumber()
    createLogger('congestion').debug('windowUtilized: %s', amountUtilizedInWindow)

    return Int.from(amountLimitInWindow - amountUtilizedInWindow) ?? Int.ZERO
  }

  applyRequest({ sourceAmount }: StreamRequest): ((reply: StreamReply) => void) | void {
    if (!sourceAmount.isPositive()) {
      return
    }

    this.amountInFlight = this.amountInFlight.add(sourceAmount)

    return (reply: StreamReply) => {
      this.amountInFlight = this.amountInFlight.subtract(sourceAmount)

      if (reply.isReject() && reply.ilpReject.code === IlpError.T04_INSUFFICIENT_LIQUIDITY) {
        this.requests.push({
          type: Outcome.LiquidityError,
          amount: sourceAmount.toNumber(),
          timestamp: Date.now(),
        })
      } else if (reply.isAuthentic()) {
        this.requests.push({
          type: Outcome.Ack,
          amount: sourceAmount.toNumber(),
          timestamp: Date.now(),
        })
      }

      this.pruneWindow()
    }
  }

  // TODO FOr efficiency, update the bandwidth limit right here?

  /** Remove old requests from throughput calculations */
  private pruneWindow() {
    // TODO Should this be:
    // - Time?
    // - # of acks?
    // - # of errors?
    // - # or requests (ack or error)? -> TODO This might be the way to go, preferable to time?

    const requestsToPrune = Math.max(0, this.requests.length - 20) // TODO ?
    this.requests.splice(0, requestsToPrune)
    return

    // const removeNext = () =>
    //   this.requests.filter((req) => req.type === Outcome.LiquidityError).length > 4

    // Limit to last 3 seconds
    const removeNext = () =>
      this.requests.length > 0 && Date.now() - this.requests[0].timestamp > 2000

    // Remove old requests until there are only 4 liquidity errors remaining
    while (removeNext()) {
      // this.requests.shift()
      // const index = this.requests.findIndex((req) => req.type === Outcome.LiquidityError)
      // this.requests.splice(0, index + 1)
    }
  }
}

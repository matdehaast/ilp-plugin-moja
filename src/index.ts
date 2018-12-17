import * as assert from 'assert'
import * as crypto from 'crypto'
import * as Debug from 'debug'
import * as Http from 'http'
import { EventEmitter2, Listener } from 'eventemitter2'
import { URL } from 'url'
import * as express from "express";
import * as http from "http";

// import { protocolDataToIlpAndCustom, ilpAndCustomToProtocolData } from './protocol-data-converter'

const BtpPacket = require('btp-packet')

const debug = require('ilp-logger')('ilp-plugin-moja')

type DataHandler = (data: Buffer) => Promise<Buffer>
type MoneyHandler = (amount: string) => Promise<void>

enum ReadyState {
  INITIAL = 0,
  CONNECTING = 1,
  CONNECTED = 2,
  DISCONNECTED = 3,
  READY_TO_EMIT = 4
}

const DEFAULT_TIMEOUT = 35000

const namesToCodes = {
  'UnreachableError': 'T00',
  'NotAcceptedError': 'F00',
  'InvalidFieldsError': 'F01',
  'TransferNotFoundError': 'F03',
  'InvalidFulfillmentError': 'F04',
  'DuplicateIdError': 'F05',
  'AlreadyRolledBackError': 'F06',
  'AlreadyFulfilledError': 'F07',
  'InsufficientBalanceError': 'F08'
}

/**
 * Returns BTP error code as defined by the BTP ASN.1 spec.
 */
function jsErrorToBtpError (e: Error) {
  const name: string = e.name || 'NotAcceptedError'
  const code: string = namesToCodes[name] || 'F00'

  return {
    code,
    name,
    triggeredAt: new Date(),
    data: JSON.stringify({ message: e.message })
  }
}

const ILP_PACKET_TYPES = {
  12: 'ilp-prepare',
  13: 'ilp-fulfill',
  14: 'ilp-reject'
}

/**
 * Converts BTP sub protocol data from json/plain text/octet stream to string.
 */
function subProtocolToString (data: BtpSubProtocol): string {
  let stringData

  switch (data.contentType) {
    case BtpPacket.MIME_APPLICATION_OCTET_STREAM:
      stringData = data.data.toString('base64')
      break
    case BtpPacket.MIME_APPLICATION_JSON:
    case BtpPacket.MIME_TEXT_PLAIN_UTF8:
      stringData = data.data.toString('utf8')
      break
  }

  return `${data.protocolName}=${stringData}`
}

/**
 * Goes through all the sub protocols in the packet data of a BTP packet and
 * returns a protocol map of each sub protocol with the key as the protocol
 * name and value as a string-form protocol object. Calls
 * `subProtocolToString(data)` to convert the value to a string.
 */
function generatePacketDataTracer (packetData: BtpPacketData) {
  return {
    toString: () => {
      try {
        return packetData.protocolData.map(data => {
          switch (data.protocolName) {
            case 'ilp':
              return ILP_PACKET_TYPES[data.data[0]] || ('ilp-' + data.data[0])
            default:
              return subProtocolToString(data)
          }
        }).join(';')
      } catch (err) {
        return 'serialization error. err=' + err.stack
      }
    }
  }
}

enum MessageType {
  transferPost,
  transferPut
}

export interface BtpPacket {
  requestId: number
  type: number
  data: BtpPacketData
}

export interface BtpPacketData {
  protocolData: Array<BtpSubProtocol>
  amount?: string
  code?: string
  name?: string
  triggeredAt?: Date
  data?: string
}

export interface BtpSubProtocol {
  protocolName: string
  contentType: number
  data: Buffer
}

/**
 * Constructor options for a BTP plugin. The 'Instance Management' section of
 * the RFC-24 indicates that every ledger plugin accepts an opts object, and
 * an optional api denoted as 'PluginServices.' This is the opts object.
 */
export interface IlpPluginBtpConstructorOptions {
  listener?: {
    port: number,
    secret: string
  },
  endpoint?: {
    address: string
  }
}


/**
 * This is the optional api, or 'PluginServices' interface, that is passed
 * into the ledger plugin constructor as defined in RFC-24. In this case
 * the api exposes 3 modules.
 */
export interface IlpPluginBtpConstructorModules {
  log?: any
}

export default class MojaHttpPlugin extends EventEmitter2 {
  public static version = 2

  protected _dataHandler?: DataHandler
  protected _moneyHandler?: MoneyHandler
  private _readyState: ReadyState = ReadyState.INITIAL
  protected _log: any

  private app: express.Application
  private server: http.Server

  private endpoint: string | null


  constructor (options: IlpPluginBtpConstructorOptions, modules?: IlpPluginBtpConstructorModules) {
    super()

    modules = modules || {}
    this._log = modules.log || debug
    this._log.trace = this._log.trace || Debug(this._log.debug.namespace + ':trace')
    this.app = express()

    this.endpoint = options.endpoint ? options.endpoint.address : null
  }

  // Required for different _connect signature in mini-accounts and its subclasses
  /* tslint:disable-next-line:no-empty */
  protected async _connect (...opts: any[]): Promise<void> {}
  /* tslint:disable-next-line:no-empty */
  protected async _disconnect (): Promise<void> {}

  async connect () {
    if (this._readyState > ReadyState.INITIAL) {
      return
    }

    this._readyState = ReadyState.CONNECTING

    /**
     * Setup different handlers for mojaloop
     * 1. Transfer
     * 2. Quote
     * 3. Parties
     * 4. Health
     */
    this.app.get('/', (request: any, response: any) => {
      response.send('Hello from Moja CNP!')
    })

    this.app.post('/transfers', (request: any, response: any) => {
      response.status(202).end()
    })

    // this.server = Http.createServer(this._handleIncomingHttpRequest)
    this.server = this.app.listen(3020, '0.0.0.0')

    this._log.info(`listening for requests connections on ${this.server.address()}`)

    /* To be overriden. */
    await this._connect()

    this._readyState = ReadyState.READY_TO_EMIT
    this._emitConnect()
  }

  /**
   * Close client/server and emit disconnect.
   *
   * **Important**: calls `this_disconnect` which is meant to be overriden by
   * plugins that extend BTP to add additional (e.g. ledger) functionality on
   * disconnect.
   */
  async disconnect () {
    this._emitDisconnect()

    /* To be overriden. */
    await this._disconnect()

    if (this.server) {
      this.server.close()
    }
  }

  isConnected () {
    return this._readyState === ReadyState.CONNECTED
  }


  /**
   * Deserialize incoming websocket message and call `handleIncomingBtpPacket`.
   * If error in handling btp packet, call `handleOutgoingBtpPacket` and send
   * the error through the socket.
   */
  async _handleIncomingHttpRequest (req: Http.IncomingMessage, response: Http.ServerResponse) {
    console.log(req)
    // let btpPacket: BtpPacket
    // try {
    //   btpPacket = BtpPacket.deserialize(binaryMessage)
    // } catch (err) {
    //   this._log.error('deserialization error:', err)
    //   ws.close()
    //   return
    // }
    //
    // try {
    //   await this._handleIncomingBtpPacket('', btpPacket)
    // } catch (err) {
    //   this._log.debug(`Error processing BTP packet of type ${btpPacket.type}: `, err)
    //   const error = jsErrorToBtpError(err)
    //   const requestId = btpPacket.requestId
    //   const { code, name, triggeredAt, data } = error
    //
    //   await this._handleOutgoingBtpPacket('', {
    //     type: BtpPacket.TYPE_ERROR,
    //     requestId,
    //     data: {
    //       code,
    //       name,
    //       triggeredAt,
    //       data,
    //       protocolData: []
    //     }
    //   })
    // }
  }

  /**
   * Send Btp data to counterparty. Uses `_call` which sets the proper timer for
   * expiry on response packets.
   */
  // async sendData (buffer: Buffer): Promise<Buffer> {
  //   const response = await this._call('', {
  //     type: BtpPacket.TYPE_MESSAGE,
  //     requestId: await _requestId(),
  //     data: { protocolData: [{
  //         protocolName: 'ilp',
  //         contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
  //         data: buffer
  //       }] }
  //   })
  //
  //   const ilpResponse = response.protocolData
  //     .filter(p => p.protocolName === 'ilp')[0]
  //
  //   return ilpResponse
  //     ? ilpResponse.data
  //     : Buffer.alloc(0)
  // }

  /**
   * With no underlying ledger, sendMoney is a no-op.
   */
  async sendMoney (amount: string): Promise<void> {
    /* NO OP */
  }

  /**
   * Don't throw errors even if the event handler throws
   * this is especially important in plugins because
   * errors can prevent the balance from being updated correctly.
   */
  _safeEmit () {
    try {
      this.emit.apply(this, arguments)
    } catch (err) {
      const errInfo = (typeof err === 'object' && err.stack) ? err.stack : String(err)
      this._log.error('error in handler for event', arguments, errInfo)
    }
  }

  registerDataHandler (handler: DataHandler) {
    if (this._dataHandler) {
      throw new Error('requestHandler is already registered')
    }

    // TODO Is this check required? TypeScript's linter suggests not
    // tslint:disable-next-line:strict-type-predicates
    if (typeof handler !== 'function') {
      throw new Error('requestHandler must be a function')
    }

    this._log.trace('registering data handler')
    this._dataHandler = handler
  }

  deregisterDataHandler () {
    this._dataHandler = undefined
  }

  registerMoneyHandler (handler: MoneyHandler) {
    if (this._moneyHandler) {
      throw new Error('requestHandler is already registered')
    }

    // TODO Is this check required? TypeScript's linter suggests not
    // tslint:disable-next-line:strict-type-predicates
    if (typeof handler !== 'function') {
      throw new Error('requestHandler must be a function')
    }

    this._log.trace('registering money handler')
    this._moneyHandler = handler
  }

  deregisterMoneyHandler () {
    this._moneyHandler = undefined
  }

  // protocolDataToIlpAndCustom (packet: BtpPacketData) {
  //   return protocolDataToIlpAndCustom(packet)
  // }
  //
  // /**
  //  * Converts protocol map to Btp packet. Reference in
  //  * procotol-data-converter.ts.
  //  */
  // ilpAndCustomToProtocolData (obj: { ilp?: Buffer, custom?: Object , protocolMap?: Map<string, Buffer | string | Object> }) {
  //   return ilpAndCustomToProtocolData(obj)
  // }

  /**
   * Function to send Btp requests with proper timeout for response or error.
   *
   * Create a listener for for an incoming Btp response/error. Resolves on
   * btp response, rejects on btp error. Send an outgoing btp packet (request),
   * and set a timer. If the timer expires before a response/error is received, time
   * out. If a response/error is received, `_handleIncomingBtpPacket` emits
   * `__callback__`, which triggers the aforementioned listener.
   */
  protected async _call (to: string, btpPacket: BtpPacket): Promise<BtpPacketData> {
    const requestId = btpPacket.requestId

    let callback: Listener
    let timer: NodeJS.Timer
    const response = new Promise<BtpPacketData>((resolve, reject) => {
      callback = (type: number, data: BtpPacketData) => {
        switch (type) {
          case BtpPacket.TYPE_RESPONSE:
            resolve(data)
            clearTimeout(timer)
            break

          case BtpPacket.TYPE_ERROR:
            reject(new Error(JSON.stringify(data)))
            clearTimeout(timer)
            break

          default:
            throw new Error('Unknown BTP packet type: ' + type)
        }
      }
      this.once('__callback_' + requestId, callback)
    })

    await this._handleOutgoingBtpPacket(to, btpPacket)

    // const timeout = new Promise<BtpPacketData>((resolve, reject) => {
    //   timer = setTimeout(() => {
    //     this.removeListener('__callback_' + requestId, callback)
    //     reject(new Error(requestId + ' timed out'))
    //   }, this._responseTimeout)
    // })

    return Promise.race([
      response,
      // timeout
    ])
  }

  /**
   * If a response or error packet is received, trigger the callback function
   * defined in _call (i.e. response/error returned before timing out)
   * function. Throw error on PREPARE, FULFILL or REJECT packets, because they
   * are not BTP packets. If TRANSFER or MESSAGE packets are received, invoke
   * money handler or data handler respectively. Otherwise prepare a response and handle the outgoing BTP
   * packet. The reason this function does not handle sending back an ERROR
   * packet in the websocket is because that is defined in the
   * _handleIncomingWsMessage function.
   */
  protected async _handleIncomingBtpPacket (from: string, btpPacket: BtpPacket) {
    const { type, requestId, data } = btpPacket
    const typeString = BtpPacket.typeToString(type)

    this._log.trace(`received btp packet. type=${typeString} requestId=${requestId} info=${generatePacketDataTracer(data)}`)
    let result: Array<BtpSubProtocol>
    switch (type) {
      case BtpPacket.TYPE_RESPONSE:
      case BtpPacket.TYPE_ERROR:
        this.emit('__callback_' + requestId, type, data)
        return
      case BtpPacket.TYPE_PREPARE:
      case BtpPacket.TYPE_FULFILL:
      case BtpPacket.TYPE_REJECT:
        throw new Error('Unsupported BTP packet')

      case BtpPacket.TYPE_TRANSFER:
        result = await this._handleMoney(from, btpPacket)
        break

      case BtpPacket.TYPE_MESSAGE:
        // result = await this._handleData(from, btpPacket)
        break

      default:
        throw new Error('Unknown BTP packet type')
    }

    await this._handleOutgoingBtpPacket(from, {
      type: BtpPacket.TYPE_RESPONSE,
      requestId,
      // data: { protocolData: result || [] }
      data: { protocolData: [] }
    })
  }

  /**
   * Called after receiving btp packet of type message. First convert it to ILP
   * format, then handle the ILP data with the regsistered data handler, and then convert it back to BTP
   * structure and send a response. E.g. for prepare, fulfill, and reject packets.
   */
  // protected async _handleData (from: string, btpPacket: BtpPacket): Promise<Array<BtpSubProtocol>> {
  //   const { data } = btpPacket
  //   const { ilp } = data;//protocolDataToIlpAndCustom(data) /* Defined in protocol-data-converter.ts. */
  //
  //   if (!this._dataHandler) {
  //     throw new Error('no request handler registered')
  //   }
  //
  //   const response = await this._dataHandler(ilp)
  //   // return ilpAndCustomToProtocolData({ ilp: response })
  //   return response
  // }

  /**
   * Need to fully define on you own.
   */
  protected async _handleMoney (from: string, btpPacket: BtpPacket): Promise<Array<BtpSubProtocol>> {
    throw new Error('No sendMoney functionality is included in this module')
  }

  /**
   * Send a BTP packet to a user and wait for the promise to resolve without
   * error.
   */
  protected async _handleOutgoingBtpPacket (to: string, btpPacket: BtpPacket) {

    // const { type, requestId, data } = btpPacket
    // const typeString = BtpPacket.typeToString(type)
    // this._log.trace(`sending btp packet. type=${typeString} requestId=${requestId} info=${generatePacketDataTracer(data)}`)
    //
    // try {
    //   await new Promise((resolve) => ws!.send(BtpPacket.serialize(btpPacket), resolve))
    // } catch (e) {
    //   this._log.error('unable to send btp message to client: ' + e.message, 'btp packet:', JSON.stringify(btpPacket))
    // }
  }

  /**
   * If the instance is not already disconnected, change the ReadyState and
   * emit a disconnect event.
   */
  private _emitDisconnect () {
    if (this._readyState !== ReadyState.DISCONNECTED) {
      this._readyState = ReadyState.DISCONNECTED
      this.emit('disconnect')
    }
  }

  /**
   * If the ReadyState is CONNECTING it implies a first time connect, so
   * accordingly emit that message. Otherwise if the instance has already
   * registered listeners (i.e. connected before) and is in the appropriate
   * ready state then emit a normal 'connect' event.
   */
  private _emitConnect () {
    if (this._readyState === ReadyState.CONNECTING) {
      this.emit('_first_time_connect')
    } else if (this._readyState === ReadyState.READY_TO_EMIT || this._readyState === ReadyState.DISCONNECTED) {
      this._readyState = ReadyState.CONNECTED
      this.emit('connect')
    }
  }
}


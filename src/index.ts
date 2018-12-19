import * as crypto from 'crypto'
import * as Debug from 'debug'
import * as Http from 'http'
import { EventEmitter2, Listener } from 'eventemitter2'
import { URL } from 'url'
import * as express from 'express'
import * as bodyParser from 'body-parser'
import * as axios from 'axios'
import {
  isFulfill,
  IlpPrepare,
  serializeIlpPrepare,
  IlpReply,
  deserializeIlpPrepare, serializeIlpReply, IlpFulfill, deserializeIlpReply
} from 'ilp-packet'

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

const ILP_PACKET_TYPES = {
  12: 'ilp-prepare',
  13: 'ilp-fulfill',
  14: 'ilp-reject'
}

enum MessageType {
  transferPost,
  transferPut
}

/**
 * Constructor options for a BTP plugin. The 'Instance Management' section of
 * the RFC-24 indicates that every ledger plugin accepts an opts object, and
 * an optional api denoted as 'PluginServices.' This is the opts object.
 */
export interface IlpPluginHttpConstructorOptions {
  listener: {
    port: number,
    baseAddress: string,
    host: string
  }
  server: {
    endpoint: string
  }
}

/**
 * This is the optional api, or 'PluginServices' interface, that is passed
 * into the ledger plugin constructor as defined in RFC-24. In this case
 * the api exposes 1 module.
 */
export interface IlpPluginHttpConstructorModules {
  log?: any
}

export default class MojaHttpPlugin extends EventEmitter2 {
  public static version = 2

  protected _dataHandler?: DataHandler
  protected _moneyHandler?: MoneyHandler
  private _readyState: ReadyState = ReadyState.INITIAL
  protected _log: any

  private app: express.Application
  private server: Http.Server
  private host: string
  private port: number
  private baseAddress: string
  private endpoint: string
  private client: any

  constructor (options: IlpPluginHttpConstructorOptions, modules?: IlpPluginHttpConstructorModules) {
    super()

    modules = modules || {}
    this._log = modules.log || debug
    this._log.trace = this._log.trace || Debug(this._log.debug.namespace + ':trace')
    this.app = express()
    this.app.use(bodyParser.urlencoded({ extended: true }))
    this.app.use(bodyParser.json())

    this.port = options.listener ? options.listener.port : 1080
    this.host = options.listener ? options.listener.host : 'localhost'
    this.baseAddress = options.listener ? options.listener.baseAddress : ''
    this.endpoint = options.server.endpoint
    this.client = axios
  }

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
    this.app.get(this.baseAddress + '/', (request: any, response: any) => {
      response.send('Hello from Moja CNP!')
    })

    this.app.post(this.baseAddress + '/transfers', this._handleTransferPostRequest.bind(this))

    this.app.put(this.baseAddress + '/transfers/:transferId', this._handleTransferPutRequest.bind(this))

    this.server = this.app.listen(this.port, this.host)

    this._log.info(`listening for requests connections on ${this.server.address()}`)

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

    if (this.server) {
      this.server.close()
    }
  }

  isConnected () {
    return this._readyState === ReadyState.CONNECTED
  }

  /**
   * Convert incoming http request into ilpPacket then forward onto connector.
   * Return a 200 to sender if packet was successgully forwarded, 422 if not.
   */
  async _handleTransferPostRequest (request: express.Request, response: express.Response) {
    try {
      const { amount, expiration, condition, transferId } = request.body
      const ilpPrepare = {
        amount: amount.amount,
        expiresAt: new Date(expiration),
        destination: request.headers['fspiop-final-destination'] ? request.headers['fspiop-final-destination'] : request.headers['fspiop-destination'],
        data: Buffer.from(JSON.stringify(request.body)),
        executionCondition: Buffer.from(condition, 'base64')
      } as IlpPrepare
      response.status(202).end()

      if (!this._dataHandler) {
        this._log.error('No data handler defined.')
        throw new Error('No data handler is defined.')
      }

      try {
        const packet = await this._dataHandler(serializeIlpPrepare(ilpPrepare))
        const ilpReply = deserializeIlpReply(packet)
        const transferReply = JSON.parse(ilpReply.data.toString())

        this.client.put(this.endpoint + '/transfers/' + transferId, transferReply, { headers: transferReply.headers })
      } catch (err) {
        // TODO: check mojaloop api spec to see which endpoint rejects go to
        const packet = err
      }

    } catch (err) {
      response.status(422).end()
    }
  }

  /**
   * Called after receiving a transfer put request. Emits event to resolve listener from _call. The headers received are encoded
   * into the data section of the ilpFulfill
   */
  async _handleTransferPutRequest (request: express.Request, response: express.Response) {

    const transferId = request.params.transferId
    this._log.info(`received fulfill transfer request. transferId=${transferId}, headers=${request.headers}, message=${request.body}`)

    let payload = request.body
    payload.headers = {
      'content-type': 'application/vnd.interoperability.transfers+json;version=1',
      'fspiop-final-destination': request.headers['fspiop-final-destination'],
      'fspiop-source': request.headers['fspiop-source']
    }

    const ilpFulfill = {
      fulfillment: Buffer.from(payload.fulfillment),
      data: Buffer.from(JSON.stringify(payload))
    } as IlpFulfill

    this.emit('__callback_' + transferId, ilpFulfill)
    response.status(202).end()
  }

  /**
   * Send Btp data to counterparty. Uses `_call` which sets the listener for response packets received via /transfer/{transfer_id}
   */
  async sendData (buffer: Buffer): Promise<Buffer> {
    const response = await this._call(deserializeIlpPrepare(buffer))
    return serializeIlpReply(response)
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

  /**
   * Create a listener for a put /transfer/{transfer_id} request. Listener create Send IlpPacket
   */
  protected async _call (packet: IlpPrepare): Promise<IlpReply> {
    const requestId = JSON.parse(packet.data.toString()).transferId

    let callback: Listener
    const response = new Promise<IlpReply>((resolve, reject) => {
      callback = (packet: IlpReply) => isFulfill(packet) ? resolve(packet) : reject(packet)
      this.once('__callback_' + requestId, callback)
    })

    await this._postIlpPrepare(packet)
    return response
  }

  /**
   * Converts given IlpPrepare packet into Moja packet and posts it to the given endpoint.
   */
  protected async _postIlpPrepare (packet: IlpPrepare, endpoint?: string, requestId?: string) {

    this._log.trace(`sending prepare packet over http. requestId=${requestId} packet=${JSON.stringify(packet)}`)

    try {
      let transferRequest = JSON.parse(packet.data.toString())
      transferRequest.payerFsp = 'moja.superremit'
      // convert to moja packet
      const headers = {
        'fspiop-final-destination': packet.destination,
        'fspiop-source': 'source', // TODO: store source info
        'accept': 'application/vnd.interoperability.transfers+json;version=1',
        'content-type': 'application/vnd.interoperability.transfers+json;version=1'
      }

      this._log.info('posting to endpoint:', endpoint, 'headers', headers,'transfer request:', transferRequest)
      this.client.post(this.endpoint + '/transfers', transferRequest, { headers })
    } catch (e) {
      this._log.error('unable to send http message to client: ' + e.message, 'packet:', JSON.stringify(packet))
    }
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

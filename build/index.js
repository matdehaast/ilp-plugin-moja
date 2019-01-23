"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const Debug = require("debug");
const eventemitter2_1 = require("eventemitter2");
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const ilp_packet_1 = require("ilp-packet");
const debug = require('ilp-logger')('ilp-plugin-moja');
const headerPattern = RegExp('^application\\/vnd.interoperability.(transfers|quotes|parties)\\+json;version=1.0');
const MOJA_QUOTE_PROTOCOL_FULFILLMENT = Buffer.alloc(32);
const MOJA_QUOTE_PROTOCOL_CONDITION = Buffer.from('Zmh6rfhivXdsj8GLjp+OIAiXFIVu4jOzkCpZHQ1fKSU=', 'base64');
var ReadyState;
(function (ReadyState) {
    ReadyState[ReadyState["INITIAL"] = 0] = "INITIAL";
    ReadyState[ReadyState["CONNECTING"] = 1] = "CONNECTING";
    ReadyState[ReadyState["CONNECTED"] = 2] = "CONNECTED";
    ReadyState[ReadyState["DISCONNECTED"] = 3] = "DISCONNECTED";
    ReadyState[ReadyState["READY_TO_EMIT"] = 4] = "READY_TO_EMIT";
})(ReadyState || (ReadyState = {}));
const DEFAULT_TIMEOUT = 35000;
var MessageType;
(function (MessageType) {
    MessageType[MessageType["transfer"] = 0] = "transfer";
    MessageType[MessageType["transferError"] = 1] = "transferError";
    MessageType[MessageType["quote"] = 2] = "quote";
    MessageType[MessageType["quoteError"] = 3] = "quoteError";
})(MessageType = exports.MessageType || (exports.MessageType = {}));
class MojaHttpPlugin extends eventemitter2_1.EventEmitter2 {
    constructor(options, modules) {
        super();
        this._readyState = ReadyState.INITIAL;
        modules = modules || {};
        this._log = modules.log || debug;
        this._log.trace = this._log.trace || Debug(this._log.debug.namespace + ':trace');
        this.app = express();
        this.app.use(bodyParser.urlencoded({ extended: true }));
        this.app.use(bodyParser.json({ type: req => req.headers['content-type'] === 'application/json' || headerPattern.test(req.headers['content-type']) }));
        this.ilpAddress = options.ilpAddress;
        this.port = options.listener ? options.listener.port : 1080;
        this.host = options.listener ? options.listener.host : 'localhost';
        this.baseAddress = options.listener ? options.listener.baseAddress : '';
        this.endpoint = options.server.endpoint;
        this.client = axios;
        this.transfersEndpoint = options.endpoints.transfers;
        this.quotesEndpoint = options.endpoints.quotes;
    }
    async connect() {
        if (this._readyState > ReadyState.INITIAL) {
            return;
        }
        this._readyState = ReadyState.CONNECTING;
        this.app.get(this.baseAddress + '/', (request, response) => {
            response.send('Hello from Moja CNP!');
        });
        this.app.post(this.baseAddress + '/transfers', this._handleTransferPostRequest.bind(this));
        this.app.put(this.baseAddress + '/transfers/:transferId', this._handleTransferPutRequest.bind(this));
        this.app.put(this.baseAddress + '/transfers/:transferId/error', this._handleTransferErrorPutRequest.bind(this));
        this.app.post(this.baseAddress + '/quotes', this._handleQuotePostRequest.bind(this));
        this.app.put(this.baseAddress + '/quotes/:quoteId', this._handleQuotePutRequest.bind(this));
        this.server = this.app.listen(this.port, this.host);
        this._log.info(`listening for requests connections on ${this.server.address()}. port=${this.port}, host=${this.host}`);
        this._readyState = ReadyState.READY_TO_EMIT;
        this._emitConnect();
    }
    async disconnect() {
        this._emitDisconnect();
        if (this.server) {
            this.server.close();
        }
    }
    isConnected() {
        return this._readyState === ReadyState.CONNECTED;
    }
    async _handleTransferErrorRequest(request, response) {
        console.log("received transfer error. transferId=", request.params.transfer_id);
        console.log("headers", request.headers);
        console.log("body", request.body);
    }
    async _handleTransferPostRequest(request, response) {
        try {
            this._log.info(`received request transfer. headers=${JSON.stringify(request.headers)}, body=${JSON.stringify(request.body)},  amount=${request.body.amount}`);
            const { amount, expiration, condition, transferId } = request.body;
            const ilpMojaData = {
                requestType: MessageType.transfer,
                uniqueId: transferId,
                requestBody: request.body,
                requestHeaders: request.headers
            };
            const ilpPrepare = {
                amount: amount.amount,
                expiresAt: new Date(expiration),
                destination: request.headers['fspiop-final-destination'] ? request.headers['fspiop-final-destination'] : request.headers['fspiop-destination'],
                data: Buffer.from(JSON.stringify(ilpMojaData)),
                executionCondition: Buffer.from(condition, 'base64')
            };
            response.status(202).end();
            if (!this._dataHandler) {
                this._log.error('No data handler defined.');
                throw new Error('No data handler is defined.');
            }
            try {
                const packet = await this._dataHandler(ilp_packet_1.serializeIlpPrepare(ilpPrepare));
                const ilpReply = ilp_packet_1.deserializeIlpReply(packet);
                const transferReply = JSON.parse(ilpReply.data.toString());
                this._log.info(`sending put request to ${this.transfersEndpoint} for transferId=${transferId}`);
                const headers = Object.assign({}, transferReply.requestHeaders, { 'fspiop-final-destination': request.headers['fspiop-source'] });
                this.client.put(this.transfersEndpoint + '/transfers/' + transferId, transferReply.requestBody, { headers });
            }
            catch (err) {
                this._log.info(`Error in post transfer request. transferId=${transferId}, endpoint=${this.transfersEndpoint + '/transfers/' + transferId}`, err);
            }
        }
        catch (err) {
            this._log.info(`Error in processing incoming transfer request`, err, request);
            response.status(400).end(err.message);
        }
    }
    async _handleTransferPutRequest(request, response) {
        const transferId = request.params.transferId;
        this._log.info(`received fulfill transfer request. transferId=${transferId}`);
        const requestBody = request.body;
        const ilpMojaData = {
            requestType: MessageType.transfer,
            uniqueId: transferId,
            requestBody,
            requestHeaders: {
                'content-type': 'application/vnd.interoperability.transfers+json;version=1.0',
                'fspiop-final-destination': request.headers['fspiop-final-destination'],
                'fspiop-source': this.ilpAddress,
                'date': request.headers['date']
            }
        };
        const ilpFulfill = {
            fulfillment: Buffer.from(requestBody.fulfilment, 'base64'),
            data: Buffer.from(JSON.stringify(ilpMojaData))
        };
        this.emit('__callback_' + transferId, ilpFulfill);
        response.status(202).end();
    }
    async _handleTransferErrorPutRequest(request, response) {
        const transferId = request.params.transferId;
        this._log.info(`received error for transfer request. transferId=${transferId}`);
        const ilpMojaData = {
            requestType: MessageType.transferError,
            uniqueId: transferId,
            requestBody: request.body,
            requestHeaders: {
                'content-type': 'application/vnd.interoperability.transfers+json;version=1.0',
                'fspiop-final-destination': request.headers['fspiop-final-destination'],
                'fspiop-source': this.ilpAddress,
                'date': request.headers['date']
            }
        };
        const ilpFulfill = {
            fulfillment: Buffer.from(ilpMojaData.requestBody.fulfilment, 'base64'),
            data: Buffer.from(JSON.stringify(ilpMojaData))
        };
        this.emit('__callback_' + transferId, ilpFulfill);
        response.status(202).end();
    }
    async _handleQuotePostRequest(request, response) {
        try {
            this._log.info(`received request quotes. headers=${JSON.stringify(request.headers)}, body=${JSON.stringify(request.body)}`);
            const { amount, quoteId } = request.body;
            const ilpMojaData = {
                requestType: MessageType.quote,
                uniqueId: quoteId,
                requestBody: request.body,
                requestHeaders: request.headers
            };
            const ilpPrepare = {
                amount: amount.amount,
                expiresAt: new Date('2019-02-28'),
                destination: request.headers['fspiop-final-destination'] ? request.headers['fspiop-final-destination'] : request.headers['fspiop-destination'],
                data: Buffer.from(JSON.stringify(ilpMojaData)),
                executionCondition: MOJA_QUOTE_PROTOCOL_CONDITION
            };
            response.status(202).end();
            if (!this._dataHandler) {
                this._log.error('No data handler defined.');
                throw new Error('No data handler is defined.');
            }
            try {
                const packet = await this._dataHandler(ilp_packet_1.serializeIlpPrepare(ilpPrepare));
                const ilpReply = ilp_packet_1.deserializeIlpReply(packet);
                const transferReply = JSON.parse(ilpReply.data.toString());
                this._log.info(`sending put request to ${this.quotesEndpoint} for transferId=${quoteId}`);
                const headers = Object.assign({}, transferReply.requestHeaders, { 'fspiop-final-destination': request.headers['fspiop-source'] });
                this.client.put(this.quotesEndpoint + '/quotes/' + quoteId, transferReply.requestBody, { headers });
            }
            catch (err) {
                const packet = err;
                console.log('ERROR:', err);
            }
        }
        catch (err) {
            response.status(422).end(err.message);
        }
    }
    async _handleQuotePutRequest(request, response) {
        const quoteId = request.params.quoteId;
        this._log.info(`received fulfill quote request. quoteId=${quoteId}`);
        const ilpMojaData = {
            requestType: MessageType.quote,
            uniqueId: quoteId,
            requestBody: request.body,
            requestHeaders: {
                'content-type': 'application/vnd.interoperability.quotes+json;version=1.0',
                'fspiop-final-destination': request.headers['fspiop-final-destination'],
                'fspiop-source': this.ilpAddress,
                'date': (new Date()).toUTCString()
            }
        };
        const ilpFulfill = {
            fulfillment: MOJA_QUOTE_PROTOCOL_FULFILLMENT,
            data: Buffer.from(JSON.stringify(ilpMojaData))
        };
        this.emit('__callback_' + quoteId, ilpFulfill);
        response.status(202).end();
    }
    async sendData(buffer) {
        const response = await this._call(ilp_packet_1.deserializeIlpPrepare(buffer));
        return ilp_packet_1.serializeIlpReply(response);
    }
    registerMoneyHandler(handler) {
        if (this._moneyHandler) {
            throw new Error('requestHandler is already registered');
        }
        if (typeof handler !== 'function') {
            throw new Error('requestHandler must be a function');
        }
        this._log.trace('registering money handler');
        this._moneyHandler = handler;
    }
    deregisterMoneyHandler() {
        this._moneyHandler = undefined;
    }
    async sendMoney(amount) {
    }
    _safeEmit() {
        try {
            this.emit.apply(this, arguments);
        }
        catch (err) {
            const errInfo = (typeof err === 'object' && err.stack) ? err.stack : String(err);
            this._log.error('error in handler for event', arguments, errInfo);
        }
    }
    registerDataHandler(handler) {
        if (this._dataHandler) {
            throw new Error('requestHandler is already registered');
        }
        if (typeof handler !== 'function') {
            throw new Error('requestHandler must be a function');
        }
        this._log.trace('registering data handler');
        this._dataHandler = handler;
    }
    deregisterDataHandler() {
        this._dataHandler = undefined;
    }
    async _call(packet) {
        const uniqueId = JSON.parse(packet.data.toString()).uniqueId;
        let callback;
        const response = new Promise((resolve, reject) => {
            callback = (packet) => ilp_packet_1.isFulfill(packet) ? resolve(packet) : reject(packet);
            this.once('__callback_' + uniqueId, callback);
        });
        await this._postIlpPrepare(packet);
        return response;
    }
    async _postIlpPrepare(packet, requestId) {
        this._log.trace(`posting prepare request to for requestId=${requestId} packet=${JSON.stringify(packet)}`);
        try {
            const packetData = JSON.parse(packet.data.toString());
            let transferRequest = packetData.requestBody;
            let headers = null;
            switch (packetData.requestType) {
                case (MessageType.transfer):
                    transferRequest.payerFsp = this.ilpAddress;
                    transferRequest.payeeFsp = packet.destination;
                    headers = {
                        'fspiop-final-destination': packet.destination,
                        'fspiop-source': this.ilpAddress,
                        'accept': 'application/vnd.interoperability.transfers+json;version=1.0',
                        'content-type': 'application/vnd.interoperability.transfers+json;version=1.0',
                        'date': packetData.requestHeaders['date']
                    };
                    this._log.info('posting transfer to endpoint:', this.endpoint, 'headers', headers, 'transfer request:', transferRequest);
                    this.client.post(this.endpoint + '/transfers', transferRequest, { headers }).catch((err) => console.log(err));
                    break;
                case (MessageType.quote):
                    transferRequest.payerFsp = this.ilpAddress;
                    transferRequest.payeeFsp = packet.destination;
                    headers = {
                        'fspiop-final-destination': packet.destination,
                        'fspiop-source': this.ilpAddress,
                        'accept': 'application/vnd.interoperability.quotes+json;version=1.0',
                        'content-type': 'application/vnd.interoperability.quotes+json;version=1.0',
                        'date': packetData.requestHeaders['date']
                    };
                    this._log.info('posting quote to endpoint:', this.quotesEndpoint, 'headers', headers, 'transfer request:', transferRequest);
                    this.client.post(this.quotesEndpoint + '/quotes', transferRequest, { headers }).catch((err) => console.log(err));
                    break;
                default:
                    this._log.error('Unable to forward request for type ', packetData.requestType);
            }
        }
        catch (e) {
            this._log.error('unable to send http message to client: ' + e.message, 'packet:', JSON.stringify(packet));
        }
    }
    _emitDisconnect() {
        if (this._readyState !== ReadyState.DISCONNECTED) {
            this._readyState = ReadyState.DISCONNECTED;
            this.emit('disconnect');
        }
    }
    _emitConnect() {
        if (this._readyState === ReadyState.CONNECTING) {
            this.emit('_first_time_connect');
        }
        else if (this._readyState === ReadyState.READY_TO_EMIT || this._readyState === ReadyState.DISCONNECTED) {
            this._readyState = ReadyState.CONNECTED;
            this.emit('connect');
        }
    }
}
MojaHttpPlugin.version = 2;
exports.default = MojaHttpPlugin;
//# sourceMappingURL=index.js.map
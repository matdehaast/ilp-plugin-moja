/// <reference types="node" />
import { EventEmitter2 } from 'eventemitter2';
import * as express from 'express';
import { IlpPrepare, IlpReply } from 'ilp-packet';
declare type DataHandler = (data: Buffer) => Promise<Buffer>;
declare type MoneyHandler = (amount: string) => Promise<void>;
export declare enum MessageType {
    transfer = 0,
    transferError = 1,
    quote = 2,
    quoteError = 3
}
export interface IlpPluginHttpConstructorOptions {
    ilpAddress: string;
    listener: {
        port: number;
        baseAddress: string;
        host: string;
    };
    server: {
        endpoint: string;
    };
    endpoints: {
        transfers: string;
        quotes: string;
    };
}
export interface IlpPluginHttpConstructorModules {
    log?: any;
}
export default class MojaHttpPlugin extends EventEmitter2 {
    static version: number;
    private ilpAddress;
    protected _dataHandler?: DataHandler;
    protected _moneyHandler?: MoneyHandler;
    private _readyState;
    protected _log: any;
    private app;
    private server;
    private host;
    private port;
    private baseAddress;
    private endpoint;
    private client;
    private transfersEndpoint;
    private quotesEndpoint;
    constructor(options: IlpPluginHttpConstructorOptions, modules?: IlpPluginHttpConstructorModules);
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    isConnected(): boolean;
    _handleTransferErrorRequest(request: express.Request, response: express.Response): Promise<void>;
    private _handleTransferPostRequest;
    private _handleTransferPutRequest;
    private _handleTransferErrorPutRequest;
    _handleQuotePostRequest(request: express.Request, response: express.Response): Promise<void>;
    _handleQuotePutRequest(request: express.Request, response: express.Response): Promise<void>;
    sendData(buffer: Buffer): Promise<Buffer>;
    registerMoneyHandler(handler: MoneyHandler): void;
    deregisterMoneyHandler(): void;
    sendMoney(amount: string): Promise<void>;
    _safeEmit(): void;
    registerDataHandler(handler: DataHandler): void;
    deregisterDataHandler(): void;
    protected _call(packet: IlpPrepare): Promise<IlpReply>;
    protected _postIlpPrepare(packet: IlpPrepare, requestId?: string): Promise<void>;
    private _emitDisconnect;
    private _emitConnect;
}
export {};

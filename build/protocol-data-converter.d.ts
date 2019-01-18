export declare enum RequestType {
    TransferPost = 0,
    TransferPut = 1,
    TransferError = 2,
    QuotePost = 3,
    QuotePut = 4,
    QuoteError = 5
}
export interface MojaRequest {
    uniqueId: string;
    type: RequestType;
    request: object;
    headers: object;
}

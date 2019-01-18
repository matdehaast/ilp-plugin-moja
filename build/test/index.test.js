"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const sinon = require("sinon");
const ilp_packet_1 = require("ilp-packet");
const src_1 = require("../src");
const assert = require('assert');
const axios = require('axios');
describe('Server', function () {
    let httpPlugin;
    let port = 3020;
    let host = '0.0.0.0';
    let baseAddress = '';
    beforeEach(async function () {
        httpPlugin = new src_1.default({
            ilpAddress: 'moja.superremit',
            listener: {
                port: port,
                host: host,
                baseAddress: baseAddress
            },
            server: {
                endpoint: ''
            },
            endpoints: {
                transfers: '',
                quotes: ''
            }
        }, {});
        await httpPlugin.connect();
    });
    afterEach(async function () {
        await httpPlugin.disconnect();
    });
    describe('Transfer Requests', function () {
        const transferRequest = {
            transferId: 'b51ec534-ee48-4575-b6a9-ead2955b8069',
            payerFsp: 'moja.za.blue.zar.green',
            payeeFsp: 'moja.tz.red.tzs.pink',
            amount: {
                currency: 'USD',
                amount: '123'
            },
            ilpPacket: 'AYIBgQAAAAAAAASwNGxldmVsb25lLmRmc3AxLm1lci45T2RTOF81MDdqUUZERmZlakgyOVc4bXFmNEpLMHlGTFGCAUBQU0svMS4wCk5vbmNlOiB1SXlweUYzY3pYSXBFdzVVc05TYWh3CkVuY3J5cHRpb246IG5vbmUKUGF5bWVudC1JZDogMTMyMzZhM2ItOGZhOC00MTYzLTg0NDctNGMzZWQzZGE5OGE3CgpDb250ZW50LUxlbmd0aDogMTM1CkNvbnRlbnQtVHlwZTogYXBwbGljYXRpb24vanNvbgpTZW5kZXItSWRlbnRpZmllcjogOTI4MDYzOTEKCiJ7XCJmZWVcIjowLFwidHJhbnNmZXJDb2RlXCI6XCJpbnZvaWNlXCIsXCJkZWJpdE5hbWVcIjpcImFsaWNlIGNvb3BlclwiLFwiY3JlZGl0TmFtZVwiOlwibWVyIGNoYW50XCIsXCJkZWJpdElkZW50aWZpZXJcIjpcIjkyODA2MzkxXCJ9IgA',
            condition: 'f5sqb7tBTWPd5Y8BDFdMm9BJR_MNI4isf8p8n4D5pHA',
            expiration: '2016-05-24T08:38:08.699-04:00',
            extensionList: {
                extension: [
                    {
                        key: 'errorDescription',
                        value: 'This is a more detailed error description'
                    },
                    {
                        key: 'errorDescription',
                        value: 'This is a more detailed error description'
                    }
                ]
            }
        };
        const headers = {
            'accept': 'application/json',
            'content-type': 'application/json',
            'content-length': 1820,
            'date': 'Wed, 19 Nov 2018 08:14:01 GMT',
            'fspiop-source': 'moja.za.blue.zar.green',
            'fspiop-final-destination': 'moja.tz.red.tzs.pink'
        };
        describe('post /transfers', function () {
            it('returns 202', async function () {
                await axios.post('http://' + host + ':' + port + baseAddress + '/transfers', transferRequest, { headers })
                    .then((response) => {
                    assert.equal(response.status, 202);
                }).catch((error) => {
                    console.log(error.message);
                    assert.fail();
                });
            });
            it('forwards ilpPrepare packet onto connector', async function () {
                httpPlugin.registerDataHandler((data) => {
                    try {
                        const preparePacket = ilp_packet_1.deserializeIlpPrepare(data);
                        assert.equal(transferRequest.amount.amount, preparePacket.amount);
                        assert.equal(transferRequest.condition, preparePacket.executionCondition.toString('base64'));
                        assert.equal(new Date(transferRequest.expiration), preparePacket.expiresAt);
                        assert.equal(headers['fspiop-final-destination'], preparePacket.destination);
                    }
                    catch (err) {
                        throw new Error(err);
                    }
                    return new Promise(resolve => resolve(data));
                });
                await axios.post('http://' + host + ':' + port + baseAddress + '/transfers', transferRequest, { headers });
            });
            it('sends put request once data handler returns', async function () {
                const putSpy = sinon.stub(axios, 'put');
                const fulfillment = ilp_packet_1.serializeIlpFulfill({
                    fulfillment: Buffer.from('f5sqb7tBTWPd5Y8BDFdMm9BJR_MNI4isf8p8n4D5pHA', 'base64'),
                    data: Buffer.from(JSON.stringify(headers))
                });
                httpPlugin.registerDataHandler((data) => {
                    return new Promise(resolve => resolve(fulfillment));
                });
                const response = await axios.post('http://' + host + ':' + port + baseAddress + '/transfers', transferRequest, { headers });
                sinon.assert.calledOnce(putSpy);
                putSpy.restore();
            });
        });
        it('Send Data calls post method', async function () {
            const postSpy = sinon.stub(axios, 'post');
            const { amount, expiration, condition, transferId } = transferRequest;
            const ilpMojaData = {
                requestType: src_1.MessageType.transfer,
                uniqueId: transferId,
                requestBody: transferRequest,
                requestHeaders: headers
            };
            const ilpPrepare = {
                amount: amount.amount,
                expiresAt: new Date(expiration),
                destination: headers['fspiop-final-destination'] ? headers['fspiop-final-destination'] : headers['fspiop-destination'],
                data: Buffer.from(JSON.stringify(ilpMojaData)),
                executionCondition: Buffer.from(condition, 'base64')
            };
            httpPlugin.sendData(ilp_packet_1.serializeIlpPrepare(ilpPrepare));
            sinon.assert.calledOnce(postSpy);
            const args = postSpy.firstCall.args;
            assert.equal('/transfers', args[0]);
            postSpy.restore();
        });
    });
    describe('Quote Requests', function () {
        const quoteRequest = {
            quoteId: "b51ec534-ee48-4575-b6a9-ead2955b8069",
            transactionId: "a8323bc6-c228-4df2-ae82-e5a997baf899",
            transactionRequestId: "a8323bc6-c228-4df2-ae82-e5a997baf890",
            payee: {
                partyIdInfo: {
                    partyIdType: "PERSONAL_ID",
                    partyIdentifier: "16135551212",
                    partySubIdOrType: "DRIVING_LICENSE",
                    fspId: "1234"
                },
                merchantClassificationCode: "4321",
                name: "Justin Trudeau",
                personalInfo: {
                    complexName: {
                        firstName: "Justin",
                        middleName: "Pierre",
                        lastName: "Trudeau"
                    },
                    dateOfBirth: "1971-12-25"
                }
            },
            payer: {
                partyIdInfo: {
                    partyIdType: "PERSONAL_ID",
                    partyIdentifier: "16135551212",
                    partySubIdOrType: "PASSPORT",
                    fspId: "1234"
                },
                merchantClassificationCode: "1234",
                name: "Donald Trump",
                personalInfo: {
                    complexName: {
                        firstName: "Donald",
                        middleName: "John",
                        lastName: "Trump"
                    },
                    dateOfBirth: "1946-06-14"
                }
            },
            amountType: "SEND",
            amount: {
                currency: "USD",
                amount: "123.45"
            },
            fees: {
                currency: "USD",
                amount: "1.25"
            },
            transactionType: {
                scenario: "DEPOSIT",
                subScenario: "locally defined sub-scenario",
                initiator: "PAYEE",
                initiatorType: "CONSUMER",
                refundInfo: {
                    originalTransactionId: "b51ec534-ee48-4575-b6a9-ead2955b8069",
                    refundReason: "free text indicating reason for the refund"
                },
                balanceOfPayments: "123"
            },
            geoCode: {
                latitude: "+45.4215",
                longitude: "+75.6972"
            },
            note: "Free-text memo",
            expiration: "2016-05-24T08:38:08.699-04:00",
            extensionList: {
                extension: [
                    {
                        key: "errorDescription",
                        value: "This is a more detailed error description"
                    },
                    {
                        key: "errorDescription",
                        value: "This is a more detailed error description"
                    }
                ]
            }
        };
        const quoteHeaders = {
            'accept': 'application/json',
            'content-type': 'application/vnd.interoperability.quotes+json;version=1.0',
            'date': 'Wed, 19 Nov 2018 08:14:01 GMT',
            'fspiop-source': 'moja.za.blue.zar.green',
            'fspiop-destination': ' moja.tz.red.tzs.pink',
            'fspiop-final-destination': ' moja.tz.red.tzs.pink'
        };
        describe('post /quotes', function () {
            it('returns 202', async function () {
                await axios.post('http://' + host + ':' + port + baseAddress + '/quotes', quoteRequest, { headers: quoteHeaders })
                    .then((response) => {
                    assert.equal(response.status, 202);
                }).catch((error) => {
                    console.log(error.message);
                    assert.fail();
                });
            });
        });
    });
});
//# sourceMappingURL=index.test.js.map
import * as sinon from 'sinon'
import { deserializeIlpPrepare, IlpFulfill, serializeIlpFulfill } from 'ilp-packet'
import MojaHttpPlugin from '../src'

// Chai.use(chaiAsPromised)
const assert = require('assert')
const axios = require('axios')

describe('Server', function () {

  let httpPlugin: MojaHttpPlugin
  let port = 3020
  let host = '0.0.0.0'
  let baseAddress = ''

  // @ts-ignore
  beforeEach(async function () {
    httpPlugin = new MojaHttpPlugin({
      listener: {
        port: port,
        host: host,
        baseAddress: baseAddress
      },
      server: {
        endpoint: ''
      }
    },{})
    await httpPlugin.connect()
  })

  // @ts-ignore
  afterEach(async function () {
    await httpPlugin.disconnect()
  })

  describe('Transfer Requests', function () {
    const transferRequest = {
      transferId: 'b51ec534-ee48-4575-b6a9-ead2955b8069',
      payerFsp: 'moja.dfsp1',
      payeeFsp: 'moja.dfsp2',
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
    }

    const headers = {
      'accept': 'application/json',
      'content-type': 'application/json',
      'content-length': 1820,
      'date': 'Wed, 19 Nov 2018 08:14:01 GMT',
      'fspiop-source': 'moja.za.blue.zar.green',
      'fspiop-final-destination': ' moja.tz.red.tzs.pink'
    }

    describe('post /transfers', function () {
      it('returns 202', async function () {
        await axios.post('http://' + host + ':' + port + baseAddress + '/transfers', transferRequest, { headers })
          .then((response: any) => {
            assert.equal(response.status, 202)
          }).catch((error: any) => {
            console.log(error.message)
            assert.fail()
          })
      })

      it('forwards ilpPrepare packet onto connector', async function () {

        httpPlugin.registerDataHandler((data: any) => {

          try {
            const preparePacket = deserializeIlpPrepare(data)
            assert.equal(transferRequest.amount.amount, preparePacket.amount)
            assert.equal(transferRequest.condition, preparePacket.executionCondition.toString('base64'))
            assert.equal(new Date(transferRequest.expiration), preparePacket.expiresAt)
            assert.equal(headers['fspiop-final-destination'], preparePacket.destination)
          } catch (err) {
            assert.fail('The ilpPrepare packet was not constructed properly')
          }

          return new Promise(resolve => resolve(data))
        })

        await axios.post('http://' + host + ':' + port + baseAddress + '/transfers', transferRequest, { headers })
      })

      it('sends put request once data handler returns', async function () {
        const putSpy = sinon.stub(axios, 'put')
        const fulfillment = serializeIlpFulfill({
          fulfillment: Buffer.from('f5sqb7tBTWPd5Y8BDFdMm9BJR_MNI4isf8p8n4D5pHA', 'base64'),
          data: Buffer.from(JSON.stringify(headers))
        } as IlpFulfill)

        httpPlugin.registerDataHandler((data: any) => {
          return new Promise(resolve => resolve(fulfillment))
        })

        await axios.post('http://' + host + ':' + port + baseAddress + '/transfers', transferRequest, { headers })

        sinon.assert.calledOnce(putSpy)
        putSpy.restore()
      })
    })
  })

})

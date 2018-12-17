import 'mocha'
import * as sinon from 'sinon'

// TODO Chai vs mocha?
import * as Chai from 'chai'
import * as chaiAsPromised from 'chai-as-promised'
import MojaHttpPlugin from "../src";
import {IncomingMessage} from 'http';
import {error} from "shelljs";

Chai.use(chaiAsPromised)
const assert = Chai.assert
const http = require('http');
const axios = require('axios');



describe('Server', function () {

  let httpPlugin : MojaHttpPlugin

  // @ts-ignore
  beforeEach(async function () {
    httpPlugin = new MojaHttpPlugin({},{})
    await httpPlugin.connect()
  })

  // @ts-ignore
  afterEach(async function() {
    await httpPlugin.disconnect()
  })


  describe('Transfer Requests', function () {
    const transferRequest = {
      transferId: "b51ec534-ee48-4575-b6a9-ead2955b8069",
      payerFsp:"moja.dfsp1",
      payeeFsp:"moja.dfsp2",
      amount:{
        currency:"USD",
        amount:"123.45"
      },
      ilpPacket:"AYIBgQAAAAAAAASwNGxldmVsb25lLmRmc3AxLm1lci45T2RTOF81MDdqUUZERmZlakgyOVc4bXFmNEpLMHlGTFGCAUBQU0svMS4wCk5vbmNlOiB1SXlweUYzY3pYSXBFdzVVc05TYWh3CkVuY3J5cHRpb246IG5vbmUKUGF5bWVudC1JZDogMTMyMzZhM2ItOGZhOC00MTYzLTg0NDctNGMzZWQzZGE5OGE3CgpDb250ZW50LUxlbmd0aDogMTM1CkNvbnRlbnQtVHlwZTogYXBwbGljYXRpb24vanNvbgpTZW5kZXItSWRlbnRpZmllcjogOTI4MDYzOTEKCiJ7XCJmZWVcIjowLFwidHJhbnNmZXJDb2RlXCI6XCJpbnZvaWNlXCIsXCJkZWJpdE5hbWVcIjpcImFsaWNlIGNvb3BlclwiLFwiY3JlZGl0TmFtZVwiOlwibWVyIGNoYW50XCIsXCJkZWJpdElkZW50aWZpZXJcIjpcIjkyODA2MzkxXCJ9IgA",
      condition:"f5sqb7tBTWPd5Y8BDFdMm9BJR_MNI4isf8p8n4D5pHA",
      expiration:"2016-05-24T08:38:08.699-04:00",
      extensionList:{
        extension:[
          {
            key:"errorDescription",
            value:"This is a more detailed error description"
          },
          {
            key:"errorDescription",
            value:"This is a more detailed error description"
          }
        ]
      }
    }

    it('Accept a POST request', async function () {
      await axios.post('http://0.0.0.0:3020/transfers')
        .then((response: any) => {
          assert.equal(response.status, 202)
        }).catch((error: any) => {
          console.log(error)
          assert.isTrue(false)
        })
    })

    it('converts POST request into correct ILP format', async function () {

      httpPlugin.registerDataHandler((data: any) => {
        return new Promise(resolve => resolve(data))
      })

      await axios.post('http://0.0.0.0:3020/transfers')
        .then((response: any) => {
          assert.equal(response.status, 202)
        }).catch((error: any) => {
          console.log(error)
          assert.isTrue(false)
        })



    })
  })



})



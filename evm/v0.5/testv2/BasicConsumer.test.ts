import cbor from 'cbor'
import * as h from '../src/helpers'
import { makeDebug } from '../src/debug'
import { assertBigNum } from '../src/matchers'
import { LinkTokenFactory } from '../src/generated/LinkTokenFactory'
import { OracleFactory } from '../src/generated/OracleFactory'
import { BasicConsumerFactory } from '../src/generated/BasicConsumerFactory'
import { Instance } from '../src/contract'
import { makeTestProvider } from '../src/provider'
import { ethers } from 'ethers'
import { assert } from 'chai'

const d = makeDebug('BasicConsumer')
const basicConsumerFactory = new BasicConsumerFactory()
const oracleFactory = new OracleFactory()
const linkTokenFactory = new LinkTokenFactory()

// create ethers provider from that web3js instance
const provider = makeTestProvider()

let roles: h.Roles

beforeAll(async () => {
  const rolesAndPersonas = await h.initializeRolesAndPersonas(provider)

  roles = rolesAndPersonas.roles
})

describe('BasicConsumer', () => {
  const specId = '0x4c7b7ffb66b344fbaa64995af81e355a'.padEnd(66, '0')
  const currency = 'USD'
  const payment = h.toWei('1')
  let link: Instance<LinkTokenFactory>
  let oc: Instance<OracleFactory>
  let cc: Instance<BasicConsumerFactory>
  const deployment = h.useSnapshot(provider, async () => {
    link = await linkTokenFactory.connect(roles.defaultAccount).deploy()
    oc = await oracleFactory.connect(roles.oracleNode).deploy(link.address)
    cc = await basicConsumerFactory
      .connect(roles.defaultAccount)
      .deploy(link.address, oc.address, specId)
  })

  beforeEach(async () => {
    await deployment()
  })

  it('has a predictable gas price', async () => {
    const rec = await provider.getTransactionReceipt(
      cc.deployTransaction.hash ?? '',
    )
    assert.isBelow(rec.gasUsed?.toNumber() ?? -1, 1750000)
  })

  describe('#requestEthereumPrice', () => {
    describe('without LINK', () => {
      it('reverts', async () => {
        await h.assertActionThrows(async () => {
          await cc.requestEthereumPrice(currency, payment)
        })
      })
    })

    describe('with LINK', () => {
      beforeEach(async () => {
        await link.transfer(cc.address, h.toWei('1'))
      })

      it('triggers a log event in the Oracle contract', async () => {
        const tx = await cc.requestEthereumPrice(currency, payment)
        const receipt = await tx.wait()

        const log = receipt?.logs?.[3]
        assert.equal(log?.address.toLowerCase(), oc.address.toLowerCase())

        const request = h.decodeRunRequest(log)
        const expected = {
          path: ['USD'],
          get:
            'https://min-api.cryptocompare.com/data/price?fsym=ETH&tsyms=USD,EUR,JPY',
        }

        assert.equal(h.toHex(specId), request.jobId)
        assertBigNum(h.toWei('1'), request.payment)
        assert.equal(cc.address.toLowerCase(), request.requester.toLowerCase())
        assert.equal(1, request.dataVersion)
        assert.deepEqual(expected, cbor.decodeFirstSync(request.data))
      })

      it('has a reasonable gas cost', async () => {
        const tx = await cc.requestEthereumPrice(currency, payment)
        const receipt = await tx.wait()

        assert.isBelow(receipt?.gasUsed?.toNumber() ?? -1, 130000)
      })
    })
  })

  describe('#fulfillOracleRequest', () => {
    const response = ethers.utils.formatBytes32String('1,000,000.00')
    let request: h.RunRequest

    beforeEach(async () => {
      await link.transfer(cc.address, h.toWei('1'))
      const tx = await cc.requestEthereumPrice(currency, payment)
      const receipt = await tx.wait()

      request = h.decodeRunRequest(receipt?.logs?.[3])
    })

    it('records the data given to it by the oracle', async () => {
      await h.fulfillOracleRequest(
        oc.connect(roles.oracleNode),
        request,
        response,
      )

      const currentPrice = await cc.currentPrice()
      assert.equal(currentPrice, response)
    })

    it('logs the data given to it by the oracle', async () => {
      const tx = await h.fulfillOracleRequest(
        oc.connect(roles.oracleNode),
        request,
        response,
      )
      const receipt = await tx.wait()

      assert.equal(2, receipt?.logs?.length)
      const log = receipt?.logs?.[1]

      assert.equal(log?.topics[2], response)
    })

    describe('when the consumer does not recognize the request ID', () => {
      let otherRequest: h.RunRequest

      beforeEach(async () => {
        // Create a request directly via the oracle, rather than through the
        // chainlink client (consumer). The client should not respond to
        // fulfillment of this request, even though the oracle will faithfully
        // forward the fulfillment to it.
        const args = h.requestDataBytes(
          h.toHex(specId),
          cc.address,
          basicConsumerFactory.interface.functions.fulfill.sighash,
          43,
          '0x0',
        )
        const tx = await h.requestDataFrom(oc, link, 0, args)
        const receipt = await tx.wait()

        otherRequest = h.decodeRunRequest(receipt?.logs?.[2])
      })

      it('does not accept the data provided', async () => {
        d('otherRequest %s', otherRequest)
        await h.fulfillOracleRequest(
          oc.connect(roles.oracleNode),
          otherRequest,
          response,
        )

        const received = await cc.currentPrice()

        assert.equal(ethers.utils.parseBytes32String(received), '')
      })
    })

    describe('when called by anyone other than the oracle contract', () => {
      it('does not accept the data provided', async () => {
        await h.assertActionThrows(async () => {
          await cc.connect(roles.oracleNode).fulfill(request.id, response)
        })

        const received = await cc.currentPrice()
        assert.equal(ethers.utils.parseBytes32String(received), '')
      })
    })
  })

  describe('#cancelRequest', () => {
    const depositAmount = h.toWei('1')
    let request: h.RunRequest

    beforeEach(async () => {
      await link.transfer(cc.address, depositAmount)
      const tx = await cc.requestEthereumPrice(currency, payment)
      const receipt = await tx.wait()

      request = h.decodeRunRequest(receipt.logs?.[3])
    })

    describe('before 5 minutes', () => {
      it('cant cancel the request', async () => {
        await h.assertActionThrows(async () => {
          await cc
            .connect(roles.consumer)
            .cancelRequest(
              oc.address,
              request.id,
              request.payment,
              request.callbackFunc,
              request.expiration,
            )
        })
      })
    })

    describe('after 5 minutes', () => {
      it('can cancel the request', async () => {
        await h.increaseTime5Minutes(provider)

        await cc
          .connect(roles.consumer)
          .cancelRequest(
            oc.address,
            request.id,
            request.payment,
            request.callbackFunc,
            request.expiration,
          )
      })
    })
  })

  describe('#withdrawLink', () => {
    const depositAmount = h.toWei('1')

    beforeEach(async () => {
      await link.transfer(cc.address, depositAmount)
      const balance = await link.balanceOf(cc.address)
      assertBigNum(balance, depositAmount)
    })

    it('transfers LINK out of the contract', async () => {
      await cc.connect(roles.consumer).withdrawLink()
      const ccBalance = await link.balanceOf(cc.address)
      const consumerBalance = ethers.utils.bigNumberify(
        await link.balanceOf(roles.consumer.address),
      )
      assertBigNum(ccBalance, 0)
      assertBigNum(consumerBalance, depositAmount)
    })
  })
})

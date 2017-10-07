// Copyright Parity Technologies (UK) Ltd., 2017.
// Released under the Apache 2/MIT licenses.

'use strict';

const config = require('config');

const { RpcTransport } = require('./api/transport');
const Certifier = require('./contracts/certifier');
const FeeRegistrar = require('./contracts/fee');
const store = require('./store');
const ParityConnector = require('./api/parity');

class Refunder {
  static run (wsUrl) {
    return new Refunder(wsUrl);
  }

  constructor (wsUrl, contractAddress) {
    const transport = new RpcTransport(wsUrl);

    this._verifyLock = false;
    this._connector = new ParityConnector(transport);
    this._certifier = new Certifier(this._connector, config.get('certifierContract'));
    this._feeRegistrar = new FeeRegistrar(this._connector, config.get('feeContract'), config.get('oldFeeContract'));

    this.init();
  }

  async init () {
    try {
      await store.subscribe(store.FEE_REFUND_CHANNEL, async () => this.processRefunds());
      console.warn('\n> Started refunder!\n');
    } catch (error) {
      console.error(error);
    }
  }

  async processRefunds () {
    if (this._verifyLock) {
      return;
    }

    this._verifyLock = true;

    await store.scan(store.FEE_REFUND_CHANNEL, async (refund) => this.processRefund(refund));

    this._verifyLock = false;
  }

  async processRefund (refund) {
    const { who, origin } = JSON.parse(refund);

    console.warn(`> refunding ${origin} who paid for ${who}...`);

    try {
      const txHash = await this._feeRegistrar.refund({ who, origin });

      store.removeRefund({ who, origin });
      console.warn('TODO: store tx hash', txHash);
    } catch (error) {
      console.error(error);
    }
  }
}

Refunder.run(config.get('nodeWs'));

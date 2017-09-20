// Copyright Parity Technologies (UK) Ltd., 2017.
// Released under the Apache 2/MIT licenses.

'use strict';

const EthJS = require('ethereumjs-util');
const Router = require('koa-router');

const Onfido = require('../onfido');
const store = require('../store');
const { error } = require('./utils');
const { buf2add } = require('../utils');

const { ONFIDO_STATUS } = Onfido;

function get ({ certifier, feeRegistrar }) {
  const router = new Router({
    prefix: '/api/onfido'
  });

  router.post('/webhook', async (ctx, next) => {
    const { payload } = ctx.request.body;

    if (!payload) {
      return error(ctx);
    }

    const { resource_type: type, action, object } = payload;

    if (!type || !action || !object || !object.href) {
      return error(ctx);
    }

    if (action === 'check.completed') {
      console.warn('[WEBHOOK] Check completed', object.href);
      await store.Onfido.push(object.href);
    }

    ctx.body = 'OK';
  });

  /**
   * Get the current status of Onfido certification
   * for the given address.
   *
   * The status can be unknown, created, pending or completed.
   * The result is set if the status is completed, whether to
   * success or fail.
   */
  router.get('/:address', async (ctx, next) => {
    const { address } = ctx.params;
    const stored = await store.Onfido.get(address) || {};
    const certified = await certifier.isCertified(address);

    const { result, status = ONFIDO_STATUS.UNKNOWN, reason = 'unknown', error = '' } = stored;

    ctx.body = { certified, status, result, reason, error };
  });

  router.post('/:address/applicant', async (ctx, next) => {
    const { address } = ctx.params;
    const { firstName, lastName, signature, message } = ctx.request.body;

    if (!firstName || !lastName || firstName.length < 2 || lastName.length < 2) {
      return error(ctx, 400, 'First name and last name should be at least 2 characters long');
    }

    if (!signature) {
      return error(ctx, 400, 'Missing signature');
    }

    if (!message) {
      return error(ctx, 400, 'Missing signature\'s message');
    }

    const [certified, paid] = await Promise.all([
      certifier.isCertified(address),
      feeRegistrar.hasPaid(address)
    ]);

    if (certified) {
      return error(ctx, 400, 'Already certified');
    }

    if (!paid) {
      return error(ctx, 400, 'Missing fee payment');
    }

    const msgHash = EthJS.hashPersonalMessage(EthJS.toBuffer(message));
    const { v, r, s } = EthJS.fromRpcSig(signature);
    const signPubKey = EthJS.ecrecover(msgHash, v, r, s);
    const signAddress = buf2add(EthJS.pubToAddress(signPubKey));

    const { paymentCount, paymentOrigins } = await feeRegistrar.paymentStatus(address);

    if (!paymentOrigins.includes(signAddress)) {
      console.error('signature / payment origin mismatch', { paymentOrigins, signAddress });
      return error(ctx, 400, 'Signature / payment origin mismatch');
    }

    const checkCount = await store.Onfido.checkCount(address);

    if (checkCount >= paymentCount * 3) {
      return error(ctx, 400, 'Only 3 checks are allowed per single fee payment');
    }

    const { sdkToken, applicantId } = await Onfido.createApplicant({ firstName, lastName });

    // Store the applicant id in Redis
    await store.Onfido.set(address, { status: ONFIDO_STATUS.CREATED, applicantId });

    ctx.body = { sdkToken };
  });

  router.post('/:address/check', async (ctx, next) => {
    const { address } = ctx.params;
    const stored = await store.Onfido.get(address);
    const certified = await certifier.isCertified(address);

    if (certified) {
      return error(ctx, 400, 'Already certified');
    }

    if (!stored || stored.status !== ONFIDO_STATUS.CREATED || !stored.applicantId) {
      return error(ctx, 400, 'No application has been created for this address');
    }

    const { applicantId } = stored;
    const checks = await Onfido.getChecks(applicantId);

    if (checks.length > 0) {
      return error(ctx, 400, 'Cannot create any more checks for this applicant');
    }

    const { checkId } = await Onfido.createCheck(applicantId, address);

    // Store the applicant id in Redis
    await store.Onfido.set(address, { status: ONFIDO_STATUS.PENDING, applicantId, checkId });

    ctx.body = { result: 'ok' };
  });

  return router;
}

module.exports = get;

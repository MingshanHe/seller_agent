import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalGate } from '../src/core/approval.ts';
import { Store } from '../src/core/db.ts';

function setup(executor = async () => ({ ok: 1 })) {
  const store = new Store(':memory:');
  const calls: string[] = [];
  const gate = new ApprovalGate(store, ['admin'], {
    publish_listing: async (a) => { calls.push(a.id); return executor(); },
    deactivate_product: async () => null,
  });
  return { store, gate, calls };
}

test('非管理员不能批准，也不能放弃', () => {
  const { gate, store } = setup();
  const a = gate.propose('publish_listing', 's', {}, 'k1');
  assert.equal(gate.approve(a.id, 'stranger').ok, false);
  assert.equal(gate.reject(a.id, 'stranger').ok, false);
  assert.equal(store.action(a.id)!.status, 'pending');
  assert.ok(store.auditEntries().some((e) => e.kind === 'action.denied' && e.actor === 'stranger'));
});

test('重复点击只执行一次', async () => {
  const { gate, calls, store } = setup();
  const a = gate.propose('publish_listing', 's', {}, 'k1');
  const first = gate.approve(a.id, 'admin');
  const second = gate.approve(a.id, 'admin');
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  if (first.ok) await first.run();
  assert.equal(calls.length, 1);
  assert.equal(store.action(a.id)!.status, 'done');
});

test('同一幂等键只生成一个动作', () => {
  const { gate } = setup();
  const a = gate.propose('publish_listing', 's', {}, 'same');
  const b = gate.propose('publish_listing', 's', {}, 'same');
  assert.equal(a.id, b.id);
});

test('放弃后不能再批准', () => {
  const { gate } = setup();
  const a = gate.propose('publish_listing', 's', {}, 'k1');
  assert.equal(gate.reject(a.id, 'admin').ok, true);
  assert.equal(gate.approve(a.id, 'admin').ok, false);
});

test('执行失败记为 failed，不自动重试', async () => {
  const { gate, store } = setup(async () => { throw new Error('接口错误'); });
  const a = gate.propose('publish_listing', 's', {}, 'k1');
  const claim = gate.approve(a.id, 'admin');
  assert.ok(claim.ok);
  if (claim.ok) {
    const r = await claim.run();
    assert.deepEqual(r, { ok: false, error: '接口错误' });
  }
  assert.equal(store.action(a.id)!.status, 'failed');
  assert.equal(gate.approve(a.id, 'admin').ok, false);
});

test('批准时可以附加参数，并写进审计', () => {
  const { gate, store } = setup();
  const a = gate.propose('publish_listing', 's', { draftId: 'd' }, 'k1');
  gate.approve(a.id, 'admin', { force: true });
  assert.deepEqual(store.action(a.id)!.payload, { draftId: 'd', force: true });
  assert.ok(store.auditEntries().some((e) => e.kind === 'action.approved' && e.detail.patch?.force === true));
});

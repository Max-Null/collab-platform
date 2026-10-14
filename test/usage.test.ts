import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeUsage, parseUsage } from '../src/usage.js';

/**
 * 这一组测用量的解析与渲染。
 *
 * 最要紧的一条判据：**「没有思考」与「思考 0 token」不是一回事** ——
 * 前者是响应里根本没有 `reasoning_tokens` 字段（这次没思考），
 * 后者是「想了，但一个 token 都没花」，那种情形不存在。
 * 把前者显示成后者，就是又造了一处「看起来一样」。
 */

test('parseUsage：正常 JSON 解析回对象', () => {
  const u = parseUsage('{"promptTokens":51,"completionTokens":6,"reasoningTokens":64}');
  assert.equal(u?.promptTokens, 51);
  assert.equal(u?.completionTokens, 6);
  assert.equal(u?.reasoningTokens, 64);
});

test('parseUsage：没有用量时返回 undefined —— 那不是坏数据', () => {
  assert.equal(parseUsage(undefined), undefined);
  assert.equal(parseUsage(''), undefined);
});

test('parseUsage：坏 JSON 不抛，而是给一个能读的对象', () => {
  const u = parseUsage('{不是 JSON');
  assert.ok(u, '坏数据不该把整个列表页打挂（同 store.ts 的 changedFilesOf）');
  assert.equal(u?.promptTokens, undefined);
});

test('describeUsage：没有用量时不给话，调用方据此决定打不打这一行', () => {
  assert.equal(describeUsage(undefined), undefined);
});

test('describeUsage：思考开着时报出 token 数', () => {
  assert.equal(
    describeUsage({ promptTokens: 76, completionTokens: 70, reasoningTokens: 64 }),
    '输入 76 · 输出 70 · 思考 64',
  );
});

test('describeUsage：没有思考时明说，而不是显示成「思考 0」', () => {
  const text = describeUsage({ promptTokens: 51, completionTokens: 6 });

  assert.ok(text?.includes('没有思考'), '字段不存在就是没思考');
  assert.ok(!text?.includes('思考 0'), '「思考 0 token」这种情形不存在，不要造一个出来');
});

test('describeUsage：用量读不出来时说的是「读不出来」，不是「没有用量」', () => {
  const text = describeUsage(parseUsage('{坏掉的'));
  assert.ok(text?.includes('读不出来'));
});

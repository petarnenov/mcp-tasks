/**
 * Obligations 10 and 11 of vault/specs/mcp-client.md.
 *
 * Obligation 10's "the count matches what nginx logged" half is manual — nothing here can see
 * nginx. What is testable, and what actually goes wrong, is the bookkeeping: one entry per
 * exchange, correctly labelled, in a readable order.
 */

import { describe, expect, it, vi } from 'vitest';

import { describeRequest, MessageLog, methodOf } from '../src/log.js';

/** Most tests only care about the label; this is the POST-with-a-body shape. */
const post = (method: string) => describeRequest('POST', JSON.stringify({ jsonrpc: '2.0', id: 1, method }));

const body = (method: string) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} });

describe('10: one entry per exchange, labelled by method', () => {
    it('reads the method out of a request body', () => {
        expect(methodOf(body('tools/list'))).toBe('tools/list');
        expect(methodOf(body('server/discover'))).toBe('server/discover');
    });

    it('degrades to a label rather than throwing on anything unexpected', () => {
        expect(methodOf(undefined)).toBe('(no body)');
        expect(methodOf('not json at all')).toBe('(unparsed)');
        expect(methodOf(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }))).toBe('(response)');
    });

    it('names the first method of a batch and says how many followed', () => {
        const batch = JSON.stringify([{ method: 'tools/list' }, { method: 'tools/call' }]);

        expect(methodOf(batch)).toBe('tools/list +1');
    });

    it('records exactly one entry per exchange, newest first', () => {
        const log = new MessageLog();

        const first = log.started(post('server/discover'));
        log.answered(first, 33, true);
        const second = log.started(post('tools/list'));
        log.answered(second, 12, true);

        expect(log.entries().map((e) => e.method)).toEqual(['tools/list', 'server/discover']);
    });

    it('notifies on every change, so a renderer never has to poll', () => {
        const onChange = vi.fn();
        const log = new MessageLog(onChange);

        const exchange = log.started(post('tools/list'));
        log.answered(exchange, 5, true);
        log.clear();

        expect(onChange).toHaveBeenCalledTimes(3);
        expect(log.entries()).toEqual([]);
    });

    it('rounds the duration, because sub-millisecond precision is noise in a log', () => {
        const log = new MessageLog();
        const exchange = log.started(post('tools/list'));

        log.answered(exchange, 12.6, true);

        expect(exchange.durationMs).toBe(13);
    });
});

describe('describeRequest: a request without a body still says what it is', () => {
    // Found by pointing this client at a real 1.x server. In the 2025 era the notification channel
    // is a body-less GET, which subscriptions/listen replaced -- equally long-lived, and it was
    // being logged as "complete 2ms" exactly like the bug obligation 11 guards against.
    it('calls a body-less GET a notification stream, and marks it streaming', () => {
        expect(describeRequest('GET', undefined)).toEqual({
            label: 'GET (notification stream)',
            streaming: true,
        });
    });

    it('does not confuse a session teardown with a stream, though neither has a body', () => {
        expect(describeRequest('DELETE', undefined)).toEqual({
            label: 'DELETE (end session)',
            streaming: false,
        });
    });

    it('marks subscriptions/listen streaming and an ordinary POST not', () => {
        expect(post('subscriptions/listen').streaming).toBe(true);
        expect(post('tools/call').streaming).toBe(false);
    });
});

describe('11: an open stream is shown as streaming, not as complete or stuck', () => {
    it('marks subscriptions/listen streaming once its headers arrive', () => {
        const log = new MessageLog();
        const exchange = log.started(post('subscriptions/listen'));

        // fetch resolves at the headers; the body keeps streaming for the life of the connection.
        log.answered(exchange, 4, true);

        // Not 'complete' -- that would claim a 4ms exchange that is in fact still listening.
        expect(exchange.state).toBe('streaming');
    });

    it('leaves an unanswered request pending, so streaming is not a synonym for slow', () => {
        const log = new MessageLog();

        const exchange = log.started(post('subscriptions/listen'));

        expect(exchange.state).toBe('pending');
        expect(exchange.durationMs).toBeUndefined();
    });

    it('still marks an ordinary method complete', () => {
        const log = new MessageLog();
        const exchange = log.started(post('tools/call'));

        log.answered(exchange, 40, true);

        expect(exchange.state).toBe('complete');
    });

    it('a stream that fails is failed, not streaming', () => {
        const log = new MessageLog();
        const exchange = log.started(post('subscriptions/listen'));

        log.answered(exchange, 8, false, 'HTTP 502');

        expect(exchange.state).toBe('failed');
        expect(exchange.detail).toBe('HTTP 502');
    });
});

describe('9: an unreachable endpoint is distinguishable from a tool that failed', () => {
    it('records a transport failure with its reason and no duration', () => {
        const log = new MessageLog();
        const exchange = log.started(post('tools/call'));

        log.failed(exchange, 'Failed to fetch');

        expect(exchange.state).toBe('failed');
        expect(exchange.detail).toBe('Failed to fetch');
        expect(exchange.durationMs).toBeUndefined();
    });
});

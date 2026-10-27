const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// the 'vscode' module only exists inside the editor, so a minimal stub is served instead
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === 'vscode') return { window: {}, workspace: {} };
    return originalLoad.call(this, request, ...rest);
};
const { normalizeUrl, detectUrl, portOf, candidateUrls, INTERRUPTED_EXIT_CODES } = require('../extension.js')._test;

// fake shell execution that yields the given output chunks
function fakeExecution(chunks) {
    return {
        async *read() {
            for (const chunk of chunks) yield chunk;
        },
    };
}

test('normalizeUrl drops trailing punctuation and maps 0.0.0.0 to localhost', () => {
    assert.strictEqual(normalizeUrl('http://localhost:5173/.'), 'http://localhost:5173/');
    assert.strictEqual(normalizeUrl('http://0.0.0.0:3000'), 'http://localhost:3000');
});

test('portOf uses the explicit port or the protocol default', () => {
    assert.strictEqual(portOf('http://localhost:5173'), 5173);
    assert.strictEqual(portOf('http://localhost'), 80);
    assert.strictEqual(portOf('https://localhost'), 443);
    assert.strictEqual(portOf('not a url'), undefined);
});

test('candidateUrls puts the fallback url first without duplicates', () => {
    const urls = candidateUrls('http://127.0.0.1:3000');
    const entries = [...urls];
    assert.deepStrictEqual(entries[0], [3000, 'http://127.0.0.1:3000']);
    assert.strictEqual(entries.filter(([port]) => port === 3000).length, 1);
    assert.ok(urls.has(5173));
});

test('detectUrl finds a url in colored vite output', async () => {
    const output = '\u001b[32m  ➜  Local:\u001b[39m   \u001b[36mhttp://localhost:\u001b[1m5174\u001b[22m/\u001b[39m\n';
    const url = await detectUrl(fakeExecution([output]), new AbortController().signal, 1000);
    assert.strictEqual(url, 'http://localhost:5174/');
});

test('detectUrl joins a url split between two chunks', async () => {
    const url = await detectUrl(
        fakeExecution(['ready on http://localhost:51', '73/\n']),
        new AbortController().signal,
        1000
    );
    assert.strictEqual(url, 'http://localhost:5173/');
});

test('detectUrl gives up when the output has no url', async () => {
    const url = await detectUrl(fakeExecution(['compiling...\n']), new AbortController().signal, 1000);
    assert.strictEqual(url, undefined);
});

test('detectUrl stops on abort', async () => {
    const abort = new AbortController();
    const never = {
        async *read() {
            yield await new Promise(() => {});
        },
    };
    const pending = detectUrl(never, abort.signal, 10000);
    abort.abort();
    assert.strictEqual(await pending, undefined);
});

test('ctrl+c exit codes are not failures', () => {
    for (const code of [130, -1073741510, 3221225786]) assert.ok(INTERRUPTED_EXIT_CODES.has(code));
    assert.ok(!INTERRUPTED_EXIT_CODES.has(1));
});

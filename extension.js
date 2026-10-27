const vscode = require('vscode');
const net = require('net');

// ansi escape sequences (csi and osc), stripped before looking for the url
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?[^\s'")<>]*/i;

// ports commonly used by dev servers, scanned when the url cannot be read from the output
const COMMON_PORTS = [3000, 3001, 4200, 4321, 5173, 5174, 8000, 8080, 8888, 1234, 9000, 5000];

const SHELL_INTEGRATION_TIMEOUT_MS = 10000;
const OUTPUT_BUFFER_SIZE = 4000;
const URL_SETTLE_MS = 300;
const POLL_INTERVAL_MS = 500;
const PROBE_TIMEOUT_MS = 1000;
const OUTPUT_GRACE_MS = 2500;
const STOP_GRACE_MS = 3000;
const NO_INTEGRATION_GRACE_MS = 800;
const VISIBILITY_DEBOUNCE_MS = 300;
const MIN_STARTUP_TIMEOUT_S = 5;
// exit codes of a command stopped with ctrl+c: 130 on unix shells, 0xC000013A on windows
// (reported signed or unsigned depending on the shell)
const INTERRUPTED_EXIT_CODES = new Set([130, -1073741510, 3221225786]);

// the shell integration api was finalized in vscode 1.93, but some forks lag behind
const HAS_SHELL_INTEGRATION = typeof vscode.window.onDidChangeTerminalShellIntegration === 'function';

/**
 * everything that belongs to one run of the dev server.
 * a single object replaces several loose globals, so they can never get out of sync.
 * @typedef {{
 *   terminal: vscode.Terminal,
 *   abort: AbortController,
 *   command: string,
 *   execution?: vscode.TerminalShellExecution,
 *   started: boolean,
 *   startupDone: boolean,
 *   detectedUrl?: string,
 *   outputSettled: boolean,
 *   baseline: Set<number>,
 * }} Session
 */

/** @type {Session | undefined} */
let session;
// terminal left open after its process ended on its own, closed on the next start
/** @type {vscode.Terminal | undefined} */
let idleTerminal;
// true while a start is waiting for the folder picker, so a double click cannot start twice
let launching = false;
// pending graceful shutdowns, a new start waits for them so the port is free again
let stopping = Promise.resolve();

let statusItem;
/** @type {vscode.LogOutputChannel} */
let log;
let visibilityTimer;

const cfg = () => vscode.workspace.getConfiguration('npmDevButton');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function updateStatusBar() {
    if (session) {
        statusItem.text = '$(debug-stop) Stop Dev';
        statusItem.tooltip = 'Stop the server and close the terminal';
        // status bar items only allow warning/error background colors,
        // so the magenta highlight is applied to the text instead.
        statusItem.color = new vscode.ThemeColor('terminal.ansiMagenta');
        statusItem.backgroundColor = undefined;
    } else {
        statusItem.text = `$(debug-start) ${cfg().get('command')}`;
        statusItem.tooltip = 'Start the development server';
        statusItem.color = undefined;
        statusItem.backgroundColor = undefined;
    }
}

// shows a message and always leaves a trace in the log, with a shortcut to open it
function notify(kind, message) {
    log[kind === 'error' ? 'error' : 'warn'](message);
    const show = kind === 'error' ? vscode.window.showErrorMessage : vscode.window.showWarningMessage;
    show(`NPM Run Dev Button: ${message}`, 'Show Log').then((choice) => {
        if (choice) log.show(true);
    });
}

// show the button only when a package.json exists in the workspace
async function refreshVisibility() {
    if (session) {
        statusItem.show();
        return;
    }
    try {
        const found = await vscode.workspace.findFiles('**/package.json', '**/node_modules/**', 1);
        if (found.length > 0) statusItem.show();
        else statusItem.hide();
    } catch {
        statusItem.show();
    }
}

// package.json events can come in bursts (npm install, git checkout), so they are debounced
function scheduleVisibilityRefresh(uri) {
    if (uri?.path.includes('/node_modules/')) return;
    clearTimeout(visibilityTimer);
    visibilityTimer = setTimeout(refreshVisibility, VISIBILITY_DEBOUNCE_MS);
}

// marks the session as over and cancels everything it is waiting for
function endSession(s) {
    if (session === s) session = undefined;
    s.abort.abort();
    updateStatusBar();
}

function waitForExecutionEnd(execution, ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(done, ms);
        const sub = vscode.window.onDidEndTerminalShellExecution((e) => {
            if (e.execution === execution) done();
        });
        function done() {
            clearTimeout(timer);
            sub.dispose();
            resolve();
        }
    });
}

// asks the process to quit with ctrl+c and gives it a moment before closing the terminal,
// so dev servers can release their port and child processes are not left behind.
// never rejects.
async function shutdown(s) {
    const { terminal, execution } = s;
    try {
        if (s.started) {
            terminal.sendText('\x03', false);
            await (execution ? waitForExecutionEnd(execution, STOP_GRACE_MS) : sleep(NO_INTEGRATION_GRACE_MS));
        }
    } catch {
        // the terminal may already be gone
    }
    terminal.dispose();
}

function stop() {
    const s = session;
    if (!s) return;
    log.info('stopping the server');
    endSession(s); // the button goes back to normal right away
    stopping = Promise.all([stopping, shutdown(s)]);
}

function shellIntegrationDisabled() {
    return vscode.workspace.getConfiguration('terminal.integrated.shellIntegration').get('enabled') === false;
}

function waitForShellIntegration(terminal, ms, signal) {
    if (!HAS_SHELL_INTEGRATION || signal.aborted) return Promise.resolve(undefined);
    if (terminal.shellIntegration) return Promise.resolve(terminal.shellIntegration);
    // no point waiting for something the user turned off
    if (shellIntegrationDisabled()) return Promise.resolve(undefined);

    return new Promise((resolve) => {
        const done = (integration) => {
            clearTimeout(timer);
            sub.dispose();
            signal.removeEventListener('abort', onAbort);
            resolve(integration);
        };
        const onAbort = () => done(undefined);
        const timer = setTimeout(done, ms);
        const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
            if (e.terminal === terminal) done(e.shellIntegration);
        });
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

function normalizeUrl(raw) {
    return raw
        .replace(/[.,;:!?]+$/, '') // punctuation that belongs to the sentence, not the url
        .replace(/^(https?:\/\/)0\.0\.0\.0/i, '$1localhost');
}

// reads the command output until a local url appears, gives up after the timeout or on abort
function detectUrl(execution, signal, timeoutMs) {
    return new Promise((resolve) => {
        if (signal.aborted) return resolve(undefined);

        let finished = false;
        let settle;
        const finish = (url) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            clearTimeout(settle);
            signal.removeEventListener('abort', onAbort);
            resolve(url);
        };
        const onAbort = () => finish(undefined);
        const timer = setTimeout(finish, timeoutMs);
        signal.addEventListener('abort', onAbort, { once: true });

        (async () => {
            // the raw output is kept and cleaned as a whole, so an escape sequence
            // split between two chunks is still removed
            let raw = '';
            for await (const chunk of execution.read()) {
                if (finished) return;
                clearTimeout(settle);
                raw = (raw + chunk).slice(-OUTPUT_BUFFER_SIZE);

                const text = raw.replace(ANSI_RE, '');
                const match = URL_RE.exec(text);
                if (!match) continue;

                const url = normalizeUrl(match[0]);
                // a match that touches the end of the output may be cut in half by a chunk
                // boundary (".../localhost:51" + "73/"), so give the rest a moment to arrive
                if (match.index + match[0].length < text.length) return finish(url);
                settle = setTimeout(() => finish(url), URL_SETTLE_MS);
            }
            finish(undefined);
        })().catch(() => finish(undefined));
    });
}

function connectOnce(host, port) {
    return new Promise((resolve) => {
        const socket = net.connect({ host, port });
        const done = (ok) => {
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(PROBE_TIMEOUT_MS);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
    });
}

// a plain tcp connection is enough to know the server is listening, and unlike an http request
// it does not show up in the server logs or trigger on-demand compilation (next.js, for example).
// "localhost" is checked on both ipv4 and ipv6, since a server may listen on only one of them
async function canConnect(url) {
    let target;
    try {
        target = new URL(url);
    } catch {
        return false;
    }
    const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
    const host = target.hostname.replace(/^\[|\]$/g, '');
    const hosts = host.toLowerCase() === 'localhost' ? ['127.0.0.1', '::1'] : [host];
    const results = await Promise.all(hosts.map((h) => connectOnce(h, port)));
    return results.some(Boolean);
}

function portOf(url) {
    try {
        const u = new URL(url);
        return Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    } catch {
        return undefined;
    }
}

// the fallback url first, then the usual dev server ports
function candidateUrls(fallbackUrl) {
    const urls = new Map();
    const fallbackPort = portOf(fallbackUrl);
    if (fallbackPort) urls.set(fallbackPort, fallbackUrl);
    for (const port of COMMON_PORTS) if (!urls.has(port)) urls.set(port, `http://localhost:${port}`);
    return urls;
}

async function listeningPorts(urls) {
    const entries = [...urls];
    const open = await Promise.all(entries.map(([, url]) => canConnect(url)));
    return new Set(entries.filter((_, i) => open[i]).map(([port]) => port));
}

// ask which folder to use in a multi-root workspace
async function pickFolder() {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length <= 1) return folders[0];
    const pick = await vscode.window.showQuickPick(
        folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
        { placeHolder: 'Which folder should the server run in?' }
    );
    return pick?.folder;
}

// checks the working directory up front, a bad path would otherwise only show up as an
// error inside the terminal while the button sits in the running state
async function resolveCwd(folder, subdir) {
    if (!subdir) return folder.uri;
    const cwd = vscode.Uri.joinPath(folder.uri, subdir);
    try {
        await vscode.workspace.fs.stat(cwd);
    } catch {
        throw new Error(`Working directory not found: ${cwd.fsPath}`);
    }
    return cwd;
}

/** @returns {Session} */
function openSession(cwd, settings) {
    const command = settings.get('command');
    // empty = the default terminal profile of the user
    const shellPath = settings.get('shellPath') || undefined;
    const terminal = vscode.window.createTerminal({
        name: settings.get('terminalName'),
        cwd,
        shellPath,
        iconPath: new vscode.ThemeIcon(settings.get('terminalIcon')),
        color: new vscode.ThemeColor(settings.get('terminalColor')),
        // a restored terminal would keep a server running that the button knows nothing about
        isTransient: true,
        // tools like create react app open their own tab, which would duplicate ours
        env: settings.get('openBrowser') ? { BROWSER: 'none' } : undefined,
    });
    terminal.show();

    session = {
        terminal,
        abort: new AbortController(),
        command,
        execution: undefined,
        started: false,
        startupDone: false,
        detectedUrl: undefined,
        outputSettled: false,
        baseline: new Set(),
    };
    updateStatusBar();
    log.info(`starting "${command}" in ${cwd.fsPath} (shell: ${shellPath ?? 'default profile'})`);
    return session;
}

async function launch(s, settings) {
    const { signal } = s.abort;

    // ports that are already taken before the command runs, so an old server
    // is never mistaken for the new one
    s.baseline = await listeningPorts(candidateUrls(settings.get('fallbackUrl')));
    if (signal.aborted) return;
    if (s.baseline.size) log.info(`ports already in use before start: ${[...s.baseline].join(', ')}`);

    const integration = await waitForShellIntegration(s.terminal, SHELL_INTEGRATION_TIMEOUT_MS, signal);
    if (signal.aborted) return;

    if (integration) {
        log.info('shell integration active: the server url will be read from the terminal output');
        s.execution = integration.executeCommand(s.command);
    } else {
        log.warn(
            'shell integration is not available: the command is sent as plain text and the server ' +
                'port will be searched for instead of read from the output'
        );
        s.terminal.sendText(s.command);
    }
    s.started = true;
}

// one deadline for everything (reading the url + waiting for the port), instead of a
// fixed budget per phase. returns the url that is accepting connections, or undefined
async function findRunningServer(s, settings, deadline) {
    const { signal } = s.abort;
    // an execution adopted later (see onLateExecutionStart) is not read, so this is fixed here
    const readsOutput = Boolean(s.execution);
    const candidates = candidateUrls(settings.get('fallbackUrl'));
    const fallbackPort = portOf(settings.get('fallbackUrl'));

    if (readsOutput) {
        detectUrl(s.execution, signal, Math.max(0, deadline - Date.now())).then((url) => {
            s.outputSettled = true;
            if (url) {
                s.detectedUrl = url;
                log.info(`url found in the output: ${url}`);
            } else if (!signal.aborted) {
                log.warn('no url was found in the output');
            }
        });
    } else {
        s.outputSettled = true;
    }

    const startedAt = Date.now();
    while (!signal.aborted && Date.now() < deadline) {
        if (s.detectedUrl) {
            if (await canConnect(s.detectedUrl)) return s.detectedUrl;
        } else if (s.outputSettled || Date.now() - startedAt > OUTPUT_GRACE_MS) {
            // the output has no url (or it is slow to appear): look for a port that started listening
            const listening = await listeningPorts(candidates);
            for (const port of listening) {
                const isNew = !s.baseline.has(port);
                // without the output there is no way to tell an old server on the fallback port
                // from the new one, so that single port is accepted either way
                if (isNew || (!readsOutput && port === fallbackPort)) {
                    log.info(`port ${port} started listening`);
                    return candidates.get(port);
                }
            }
        }
        await sleep(POLL_INTERVAL_MS);
    }
    return undefined;
}

async function openWhenReady(s, settings) {
    const { signal } = s.abort;
    if (!settings.get('openBrowser')) {
        log.info('npmDevButton.openBrowser is off, not opening the browser');
        return;
    }

    const seconds = Math.max(MIN_STARTUP_TIMEOUT_S, Number(settings.get('startupTimeoutSeconds')) || 60);
    const url = await findRunningServer(s, settings, Date.now() + seconds * 1000);
    if (signal.aborted) return;

    if (!url) {
        notify(
            'warning',
            `No server was found within ${seconds}s. If it uses a fixed port, set "npmDevButton.fallbackUrl"; ` +
                'if it is just slow, raise "npmDevButton.startupTimeoutSeconds".'
        );
        return;
    }

    // resolve remote urls for wsl, remote ssh and codespaces
    const external = await vscode.env.asExternalUri(vscode.Uri.parse(url));
    log.info(`opening ${external.toString()}`);
    const opened = await vscode.env.openExternal(external);
    if (signal.aborted) return;

    if (!opened) notify('warning', `The browser could not be opened. The server is running at ${external.toString()}`);
}

function showError(error) {
    notify('error', error instanceof Error ? error.message : String(error));
}

async function start() {
    if (session || launching) return;

    if (!vscode.workspace.workspaceFolders?.length) {
        vscode.window.showErrorMessage('Open a project folder before starting the server.');
        return;
    }

    const settings = cfg();
    let cwd;

    // everything that can wait happens here, the session is created right after without
    // any await in between, so two quick clicks can never start two servers
    launching = true;
    try {
        await stopping;
        const folder = await pickFolder();
        if (!folder) return;
        cwd = await resolveCwd(folder, settings.get('workingDirectory'));
    } catch (error) {
        showError(error);
        return;
    } finally {
        launching = false;
    }

    // close the terminal left behind by a command that died on its own
    idleTerminal?.dispose();
    idleTerminal = undefined;

    let s;
    try {
        s = openSession(cwd, settings);
        await launch(s, settings);
        if (s.abort.signal.aborted) return;
        await openWhenReady(s, settings);
        // startup phase is over (browser opened, disabled or given up on): from now on the command
        // ending by itself, e.g. with ctrl+c, is a normal thing and not worth a warning
        s.startupDone = true;
    } catch (error) {
        if (s && session === s) stop();
        showError(error);
    }
}

// the command ended by itself: tell the user if that happened before the server was ready,
// or later with a failure (ctrl+c is a normal way to stop a dev server)
function onExecutionEnd(s, exitCode) {
    idleTerminal = s.terminal;
    const early = !s.startupDone;
    const failed = exitCode !== undefined && exitCode !== 0 && !INTERRUPTED_EXIT_CODES.has(exitCode);
    endSession(s);
    const withCode = exitCode === undefined ? '' : ` with exit code ${exitCode}`;
    log.info(`the command ended${withCode}`);
    if (!s.started) return;
    if (early) {
        notify('warning', `"${s.command}" ended${withCode} before the server was ready. Check the terminal output.`);
    } else if (failed) {
        notify('warning', `"${s.command}" failed${withCode}. Check the terminal output.`);
    }
}

// shell integration that showed up after the command was sent as plain text: adopt the
// execution, so the end of the command is still noticed and the button resets
function onLateExecutionStart(s, execution) {
    s.execution = execution;
    log.info('shell integration became active after the command was sent, its end will be tracked');
}

function activate(context) {
    log = vscode.window.createOutputChannel('NPM Run Dev Button', { log: true });

    statusItem = vscode.window.createStatusBarItem('npmDevButton.status', vscode.StatusBarAlignment.Right, 100);
    statusItem.name = 'NPM Run Dev Button';
    statusItem.command = 'npmDevButton.toggle';
    updateStatusBar();

    const watcher = vscode.workspace.createFileSystemWatcher('**/package.json');

    const subscriptions = [
        log,
        statusItem,
        watcher,
        { dispose: () => clearTimeout(visibilityTimer) },
        vscode.commands.registerCommand('npmDevButton.toggle', () => (session ? stop() : start())),
        vscode.commands.registerCommand('npmDevButton.showLog', () => log.show(true)),

        // reset the button when the user closes the terminal manually
        vscode.window.onDidCloseTerminal((t) => {
            if (t === idleTerminal) idleTerminal = undefined;
            if (session?.terminal === t) {
                log.info('the terminal was closed');
                endSession(session);
            }
        }),

        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('npmDevButton')) updateStatusBar();
        }),

        // keep button visibility in sync with package.json files
        vscode.workspace.onDidChangeWorkspaceFolders(() => scheduleVisibilityRefresh()),
        watcher.onDidCreate(scheduleVisibilityRefresh),
        watcher.onDidDelete(scheduleVisibilityRefresh),
    ];

    // reset the button when the process ends but the terminal stays open
    if (HAS_SHELL_INTEGRATION) {
        subscriptions.push(
            vscode.window.onDidStartTerminalShellExecution((e) => {
                const s = session;
                if (s?.started && !s.execution && e.terminal === s.terminal) onLateExecutionStart(s, e.execution);
            }),
            vscode.window.onDidEndTerminalShellExecution((e) => {
                if (session && e.execution === session.execution) onExecutionEnd(session, e.exitCode);
            })
        );
    }

    context.subscriptions.push(...subscriptions);
    refreshVisibility();
}

function deactivate() {
    session?.abort.abort();
}

module.exports = {
    activate,
    deactivate,
    // exposed for the unit tests only
    _test: { normalizeUrl, detectUrl, portOf, candidateUrls, INTERRUPTED_EXIT_CODES },
};
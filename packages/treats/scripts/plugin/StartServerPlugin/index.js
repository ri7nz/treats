const logger = require("../../util/logger"),
    sysPath = require("path"),
    childProcess = require("child_process");

class StartServerPlugin {
    constructor(options) {
        if (options == null) {
            options = {};
        }
        if (typeof options === "string") {
            options = { entryName: options };
        }
        this.options = Object.assign(
            {
                entryName: "main", // What to run
                once: false, // Run once and exit when worker exits
                args: [], // Arguments for worker
                signal: false, // Send a signal instead of a message
                // Only listen on keyboard in development, so the server doesn't hang forever
                restartable: process.env.NODE_ENV === "development"
            },
            options
        );
        if (!Array.isArray(this.options.args)) {
            throw new Error("options.args has to be an array of strings");
        }
        if (this.options.signal === true) {
            this.options.signal = "SIGUSR2";
            this.options.inject = false;
        }
        this.afterEmit = this.afterEmit.bind(this);
        this.apply = this.apply.bind(this);
        this._handleChildError = this._handleChildError.bind(this);
        this._handleChildExit = this._handleChildExit.bind(this);
        this._handleChildMessage = this._handleChildMessage.bind(this);

        this.worker = null;
        if (this.options.restartable && !options.once) {
            this._enableRestarting();
        }
    }

    _enableRestarting() {
        logger("log", "Type `rs<Enter>` to restart the worker");
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", data => {
            if (data.trim() === "rs") {
                if (this.worker) {
                    logger("log", "Killing worker...");
                    process.kill(this.worker.pid);
                } else {
                    this._runWorker();
                }
            }
        });
    }

    _getScript(compilation) {
        const { entryName } = this.options;
        const map = compilation.entrypoints;
        const entry = map.get ? map.get(entryName) : map[entryName];
        if (!entry) {
            // eslint-disable-next-line
            console.log(compilation);
            throw new Error(
                `Requested entry "${entryName}" does not exist, try one of: ${(map.keys
                    ? map.keys()
                    : Object.keys(map)
                ).join(" ")}`
            );
        }
        const entryScript = entry.chunks[0].files[0];
        if (!entryScript) {
            logger("error", "Entry chunk not outputted", entry.chunks[0]);
            return undefined;
        }
        const { path } = compilation.outputOptions;
        return sysPath.resolve(path, entryScript);
    }

    _getArgs() {
        const { options } = this;
        const execArgv = (options.nodeArgs || []).concat(process.execArgv);
        return execArgv;
    }

    _handleChildExit(code, signal) {
        if (code) logger("error", "script exited with code", code);
        if (signal && signal !== "SIGKILL") logger("log", "script exited after signal", signal);

        this.worker = null;

        if (!this.workerLoaded) {
            logger("error", "Script did not load or failed HMR, not restarting");
            return;
        }
        if (this.options.once) {
            logger("error", "Only running script once, as requested");
            return;
        }

        this.workerLoaded = false;
        if (signal !== "SIGKILL") {
            this._runWorker();
        }
    }

    _handleChildError() {
        this.worker = null;
    }

    _handleChildMessage(message) {
        if (message === "SSWP_LOADED") {
            this.workerLoaded = true;
            logger("log", "Script loaded");
        } else if (message === "SSWP_HMR_FAIL") {
            this.workerLoaded = false;
        }
    }

    _runWorker(callback) {
        if (this.worker) return;
        const {
            scriptFile,
            execArgv = [],
            options: { args }
        } = this;

        const cmdline = [...execArgv, scriptFile, "--", ...args].join(" ");
        logger("log", `running \`node ${cmdline}\``);

        const worker = childProcess.fork(scriptFile, args, { execArgv });
        worker.once("exit", this._handleChildExit);
        worker.once("error", this._handleChildError);
        worker.on("message", this._handleChildMessage);
        this.worker = worker;

        if (callback) callback();
    }

    _hmrWorker(compilation, callback) {
        const {
            worker,
            options: { signal }
        } = this;
        if (signal) {
            process.kill(worker.pid, signal);
        } else if (worker.send) {
            worker.send("SSWP_HMR");
        } else {
            logger("error", "hot reloaded but no way to tell the worker");
        }
        callback();
    }

    afterEmit(compilation, callback) {
        if (this.worker) {
            return this._hmrWorker(compilation, callback);
        }

        const scriptFile = this._getScript(compilation);
        if (!scriptFile) return undefined;
        const execArgv = this._getArgs();
        this.scriptFile = scriptFile;
        this.execArgv = execArgv;
        this._runWorker(callback);
        return undefined;
    }

    _amendEntry(entry) {
        if (typeof entry === "function")
            return (...args) => Promise.resolve(entry(...args)).then(this._amendEntry.bind(this));

        const loaderPath = require.resolve("./monitor-loader");
        const monitor = `!!${loaderPath}!${loaderPath}`;
        if (typeof entry === "string") return [entry, monitor];
        if (Array.isArray(entry)) return [...entry, monitor];
        if (typeof entry === "object")
            return Object.assign({}, entry, {
                [this.options.entryName]: this._amendEntry(entry[this.options.entryName])
            });
        throw new Error("Cannot parse webpack `entry` option");
    }

    apply(compiler) {
        compiler.options.entry = this._amendEntry(compiler.options.entry);

        // Use the Webpack 4 Hooks API when available
        if (compiler.hooks) {
            const plugin = { name: "StartServerPlugin" };

            compiler.hooks.afterEmit.tapAsync(plugin, this.afterEmit);
        } else {
            compiler.plugin("after-emit", this.afterEmit);
        }
    }
}

module.exports = StartServerPlugin;

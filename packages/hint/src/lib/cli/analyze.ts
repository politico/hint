import * as path from 'path';

import boxen from 'boxen';
import * as chalk from 'chalk';
import * as isCI from 'is-ci';
import { default as ora } from 'ora';

import { appInsights, configStore, debug as d, fs, logger, misc, network, npm } from '@hint/utils';

import {
    AnalyzerError,
    AnalyzeOptions,
    CLIOptions,
    CreateAnalyzerOptions,
    HintResources,
    UserConfig
} from '../types';
import { loadHintPackage } from '../utils/packages/load-hint-package';
import { Problem, Severity } from '@hint/utils/dist/src/types/problems';

import { createAnalyzer, getUserConfig } from '../';
import { Analyzer } from '../analyzer';
import { AnalyzerErrorStatus } from '../enums/error-status';

const { getAsUris } = network;
const { askQuestion } = misc;
const { installPackages } = npm;
const { cwd } = fs;
const debug: debug.IDebugger = d(__filename);
const configStoreKey: string = 'run';
const spinner = ora({ spinner: 'line' });

/*
 * ------------------------------------------------------------------------------
 * Private
 * ------------------------------------------------------------------------------
 */

const printFrame = (message: string) => {
    logger.log(boxen(message, {
        align: 'center',
        margin: 1,
        padding: 1
    }));
};

/**
 * Prints a message asking user to accept send telemetry data.
 */
const showTelemetryMessage = () => {
    const message: string = `Help us improve webhint
by sending limited usage information
(no personal information or URLs will be sent).

To know more about what information will be sent please
visit ${chalk.default.green('https://webhint.io/docs/user-guide/telemetry/summary/')}`;

    printFrame(message);
};

/**
 * Prints a message asking user to configure the telemetry.
 */
const showCITelemetryMessage = () => {
    const message: string = `Help us improve webhint
by sending limited usage information
(no personal information or URLs will be sent).

To know more about what information will be sent please
visit ${chalk.default.green('https://webhint.io/docs/user-guide/telemetry/summary/')}

Please configure it using
the environment variable HINT_TRACKING to 'on' or 'off'
or set the flag --tracking=on|off`;

    printFrame(message);
};

/** Ask user if he wants to activate the telemetry or not. */
const askForTelemetryConfirmation = async (userConfig: UserConfig) => {
    if (appInsights.isConfigured()) {
        return;
    }

    if (isCI) {
        if (!appInsights.isConfigured()) {
            showCITelemetryMessage();
        }

        return;
    }

    const alreadyRun: boolean = configStore.get(configStoreKey);

    if (!alreadyRun) { /* This is the first time, don't ask anything. */
        configStore.set(configStoreKey, true);

        return;
    }

    showTelemetryMessage();

    const message: string = `Do you want to opt-in?`;

    debug(`Prompting telemetry permission.`);

    const confirm: boolean = await askQuestion(message);

    if (confirm) {
        appInsights.enable();

        appInsights.trackEvent('SecondRun');
        appInsights.trackEvent('analyze', userConfig);

        return;
    }

    appInsights.disable();
};

/**
 * Prints a message telling the user a valid configuration couldn't be found and the
 * defaults will be used.
 */
const showDefaultMessage = () => {
    const defaultMessage = `${chalk.default.yellow(`Couldn't find any valid configuration`)}

Running hint with the default configuration.

Learn more about how to create your own configuration at:

${chalk.default.green('https://webhint.io/docs/user-guide/')}`;

    printFrame(defaultMessage);
};

/**
 * Prints a message to the screen alerting the user the defautl configuration
 * will be used and returns the default configuration.
 */
const getDefaultConfiguration = () => {
    showDefaultMessage();

    return { extends: ['web-recommended'] };
};

const askUserToUseDefaultConfiguration = async (): Promise<UserConfig | null> => {
    const question: string = `A valid configuration file can't be found. Do you want to use the default configuration? To know more about the default configuration see: https://webhint.io/docs/user-guide/#default-configuration`;
    const confirmation: boolean = await askQuestion(question);

    if (confirmation) {
        return getDefaultConfiguration();
    }

    return null;
};

/** Prints the list of missing and incompatible resources found. */
const showMissingAndIncompatiblePackages = (resources: HintResources) => {
    if (resources.missing.length > 0) {
        logger.log(`The following ${resources.missing.length === 1 ? 'package is' : 'packages are'} missing:
    ${resources.missing.join(', ')}`);
    }

    if (resources.incompatible.length > 0) {
        logger.log(`The following ${resources.incompatible.length === 1 ? 'package is' : 'packages are'} incompatible:
    ${resources.incompatible.join(', ')}`);
    }
};

const askUserToInstallDependencies = async (resources: HintResources): Promise<boolean> => {
    showMissingAndIncompatiblePackages(resources);

    const dependencies: string[] = resources.incompatible.concat(resources.missing);

    const question: string = `There ${dependencies.length === 1 ? 'is a package' : 'are packages'} from your .hintrc file not installed or with an incompatible version. Do you want us to try to install/update them?`;

    const answer: boolean = await askQuestion(question);

    return answer;
};

const loadUserConfig = (actions?: CLIOptions): UserConfig | null => {
    const userConfig = getUserConfig(actions && actions.config);

    if (!userConfig) {
        return getDefaultConfiguration();
    }

    return userConfig;
};

const askToInstallPackages = async (resources: HintResources): Promise<boolean> => {
    if (resources.missing.length > 0) {
        appInsights.trackEvent('missing', resources.missing);
    }

    if (resources.incompatible.length > 0) {
        appInsights.trackEvent('incompatible', resources.incompatible);
    }

    const missingPackages = resources.missing.map((name) => {
        return `@hint/${name}`;
    });

    const incompatiblePackages = resources.incompatible.map((name) => {
        // If the packages are incompatible, we need to force to install the latest version.
        return `@hint/${name}@latest`;
    });

    if (!(await askUserToInstallDependencies(resources) &&
        await installPackages(missingPackages) &&
        await installPackages(incompatiblePackages))) {

        // The user doesn't want to install the dependencies or something went wrong installing them
        return false;
    }

    // After installing all the packages, we need to load the resources again.
    return true;
};

const getAnalyzer = async (userConfig: UserConfig, options: CreateAnalyzerOptions): Promise<Analyzer> => {
    let webhint: Analyzer;

    try {
        webhint = createAnalyzer(userConfig, options);
    } catch (e) {
        const error = e as AnalyzerError;

        if (error.status === AnalyzerErrorStatus.ConfigurationError) {
            const config = await askUserToUseDefaultConfiguration();

            if (!config) {
                throw e;
            }

            return getAnalyzer(config, options);
        }

        if (error.status === AnalyzerErrorStatus.ResourceError) {
            const installed = await askToInstallPackages(error.resources!);

            if (!installed) {
                throw e;
            }

            return getAnalyzer(userConfig, options);
        }

        if (error.status === AnalyzerErrorStatus.HintError) {
            logger.error(`Invalid hint configuration in .hintrc: ${error.invalidHints!.join(', ')}.`);

            throw e;
        }

        if (error.status === AnalyzerErrorStatus.ConnectorError) {
            logger.error(`Invalid connector configuration in .hintrc`);

            throw e;
        }

        /*
         * If the error is not an AnalyzerErrorStatus
         * bubble up the exception.
         */
        logger.error(e.message, e);

        throw e;
    }

    return webhint;
};

const actionsToOptions = (actions: CLIOptions): CreateAnalyzerOptions => {
    const options: CreateAnalyzerOptions = {
        formatters: actions.formatters ? actions.formatters.split(',') : undefined,
        hints: actions.hints ? actions.hints.split(',') : undefined,
        watch: actions.watch
    };

    return options;
};

/*
 * ------------------------------------------------------------------------------
 * Public
 * ------------------------------------------------------------------------------
 */

/** Analyzes a website if indicated by `actions`. */
export default async (actions: CLIOptions): Promise<boolean> => {
    const targets = getAsUris(actions._);

    if (targets.length === 0) {
        return false;
    }

    const userConfig = await loadUserConfig(actions);

    const createAnalyzerOptions = actionsToOptions(actions);
    let webhint: Analyzer;

    try {
        webhint = await getAnalyzer(userConfig!, createAnalyzerOptions);
    } catch (e) {
        return false;
    }

    appInsights.trackEvent('analyze', userConfig!);

    const start = Date.now();
    let exitCode = 0;

    const endSpinner = (method: string) => {
        if (!actions.debug && (spinner as any)[method]) {
            (spinner as any)[method]();
        }
    };

    const hasError = (reports: Problem[]): boolean => {
        return reports.some((result: Problem) => {
            return result.severity === Severity.error;
        });
    };

    const print = async (reports: Problem[], target?: string, scanTime?: number, date?: string): Promise<void> => {
        await webhint.format(reports, {
            config: userConfig || undefined,
            date,
            output: actions.output ? path.resolve(cwd(), actions.output) : undefined,
            resources: webhint.resources,
            scanTime,
            target,
            version: loadHintPackage().version
        });
    };

    const getAnalyzeOptions = (): AnalyzeOptions => {
        const scanStart = new Map<string, number>();
        const analyzerOptions: AnalyzeOptions = {
            targetEndCallback: undefined,
            targetStartCallback: undefined,
            updateCallback: undefined
        };

        if (!actions.debug) {
            analyzerOptions.updateCallback = (update) => {
                spinner.text = update.message;
            };
        }

        analyzerOptions.targetStartCallback = (start) => {
            if (!actions.debug) {
                spinner.start();
            }
            scanStart.set(start.url, Date.now());
        };
        analyzerOptions.targetEndCallback = async (end) => {
            const scanEnd = Date.now();
            const start = scanStart.get(end.url) || 0;

            if (hasError(end.problems)) {
                exitCode = 1;
            }

            endSpinner(exitCode ? 'fail' : 'succeed');

            await print(end.problems, end.url, scanEnd - start, new Date(start).toISOString());
        };

        return analyzerOptions;
    };

    try {
        await webhint.analyze(targets, getAnalyzeOptions());

        await askForTelemetryConfirmation(userConfig!);
    } catch (e) {
        exitCode = 1;
        endSpinner('fail');
        debug(`Failed to analyze: ${e.url}`);
        debug(e);
    }

    debug(`Total runtime: ${Date.now() - start}ms`);

    return exitCode === 0;
};

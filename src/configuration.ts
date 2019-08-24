import * as child_process from 'child_process';
import * as fs from 'fs';
import * as logger from './logger';
import * as make from './make';
import * as parser from './parser';
import * as ui from './ui';
import * as util from './util';
import * as vscode from 'vscode';

let statusBar: ui.UI = ui.getUI();

// Each different scenario of building the same makefile, in the same environment, represents a configuration.
// Example: "make BUILD_TYPE=Debug" and "make BUILD_TYPE=Release" can be the debug and release configurations.
// The user can save several different such configurations in .vscode\make_configurations.json,
// from which one can be picked via this extension and saved in settings.

export interface MakeConfiguration {
	// A name associated with a particular build command process and args/options
	name: string;

	// make, nmake, specmake... 
	// This is sent to spawnChildProcess as process name
	// It can have full path, relative path or only tool name
	// Don't include args in commandName
	commandName: string;
	
	// options used in the build invocation
	// don't use more than one argument in a string
	commandArgs: string[];

	// TODO: investigate how flexible this is to integrate with other build systems than the MAKE family
	// (basically anything that can produce a dry-run output is sufficient)
	// Implement set-able dry-run, verbose, change-directory and always-make switches
	// since different tools may use different arguments for the same behavior
}

// Last configuration name picked from the set defined in .vscode\make_configurations.json.
// Saved into the settings storage. Also reflected in the configuration status bar button.
// If no particular current configuration is defined in settings, set to 'Default'.
let currentMakeConfiguration: string | undefined;
export function getCurrentMakeConfiguration(): string | undefined { return currentMakeConfiguration; }
export function setCurrentMakeConfiguration(configuration: string) {
	currentMakeConfiguration = configuration;
	statusBar.setConfiguration(currentMakeConfiguration);
	getCommandForConfiguration(currentMakeConfiguration);
}

// Read the current configuration from settings storage, update status bar item
function readCurrentMakeConfiguration() {
    let workspaceConfiguration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration();
	currentMakeConfiguration = workspaceConfiguration.get<string>("Make.buildConfiguration");
	if (!currentMakeConfiguration) {
		logger.message("No current configuration is defined in the settings file");
		currentMakeConfiguration = "Default";
    }
    
	statusBar.setConfiguration(currentMakeConfiguration);
}

// Currently, the makefile extension supports debugging only an executable.
// TODO: support dll debugging.
export interface LaunchConfiguration {
	// todo: add symbol search paths
	binary : string; // full path
	cwd : string;    // execution path
	args : string[]; // arguments
}
function launchConfigurationToString(configuration : LaunchConfiguration) : string {
	let str : string = configuration.cwd;
	str += ">";
	str += util.makeRelPath(configuration.binary, configuration.cwd);
	str += "(";
	str +=configuration.args.join(",");
	str += ")";
	return str;
}

function stringToLaunchConfiguration(str: string): LaunchConfiguration | undefined {
	let regexp = /(.*)\>(.*)\((.*)\)/mg;
	let match = regexp.exec(str);

	if (match) {
		let fullPath : string = util.makeFullPath(match[2], match[1]);
		let splitArgs: string[] = match[3].split(",");

		return {
			cwd: match[1],
			binary: fullPath,
			args: splitArgs
		}
	} else {
		return undefined;
	}
}

let currentLaunchConfiguration: LaunchConfiguration | undefined;
export function getCurrentLaunchConfiguration(): LaunchConfiguration | undefined { return currentLaunchConfiguration; }
export function setCurrentLaunchConfiguration(configuration: LaunchConfiguration) {
	currentLaunchConfiguration = configuration;
	statusBar.setLaunchConfiguration(launchConfigurationToString(currentLaunchConfiguration));
}

// Read the current launch configuration from settings storage, update status bar item
function readCurrentLaunchConfiguration() {
    let workspaceConfiguration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration();
	currentLaunchConfiguration = workspaceConfiguration.get<LaunchConfiguration>("Make.launchConfiguration");
	if (currentLaunchConfiguration) {
		statusBar.setLaunchConfiguration(launchConfigurationToString(currentLaunchConfiguration));
	} else {
		statusBar.setLaunchConfiguration("No current launch configuration is defined in the settings file");
    }
}

// Command name and args are used when building from within the VS Code Makefile Tools Extension,
// when parsing all the targets that exist and when updating the cpptools configuration provider
// for IntelliSense.
let configurationCommandName: string;
export function getConfigurationCommandName(): string { return configurationCommandName; }
export function setConfigurationCommandName(name: string) { configurationCommandName = name; }

let configurationCommandArgs: string[] = [];
export function getConfigurationCommandArgs(): string[] { return configurationCommandArgs; }
export function setConfigurationCommandArgs(args: string[]) { configurationCommandArgs = args; }

// Read from settings storage, update status bar item
// Current make configuration command = process name + arguments
function readCurrentMakeConfigurationCommand() {
	// Read from disk instead of from the MakeConfiguration array, to get up to date content
	readMakeConfigurations();
	getCommandForConfiguration(currentMakeConfiguration);
}

// Helper to find in the array of MakeConfiguration which command/args correspond to a configuration name
export function getCommandForConfiguration(configuration: string | undefined) {
	let makeConfiguration: MakeConfiguration | undefined = makeConfigurations.find(k => {
		if (k.name === currentMakeConfiguration) {
			return { ...k, keep: true };
		}
	});

	if (makeConfiguration) {
		configurationCommandName = makeConfiguration.commandName;
		configurationCommandArgs = makeConfiguration.commandArgs;
		logger.message("Found command '" + configurationCommandName + " " + configurationCommandArgs.join(" ") + "' for configuration " + currentMakeConfiguration);
	} else {
		configurationCommandName = "make";
		configurationCommandArgs = [];
		logger.message("Couldn't find explicit command for configuration " + currentMakeConfiguration + ". Assuming make.exe with no arguments.");
	}
}

// The data type mapping to the content of .vscode\make_configurations.json.
// The file is allowed to be missing, in which case the MakeConfiguration array remains empty.
let makeConfigurations: MakeConfiguration[] = [];
export function getMakeConfigurations(): MakeConfiguration[] { return makeConfigurations; }
export function setMakeConfigurations(configurations: MakeConfiguration[]) { makeConfigurations = configurations; }

function readMakeConfigurations() {
	let configurationsJsonPath: string = vscode.workspace.rootPath + "\/.vscode\/make_configurations.json";
	if (util.checkFileExistsSync(configurationsJsonPath)) {
		logger.message("Reading configurations from file \/.vscode\/make_configurations.json");
		const jsonConfigurationsContent: Buffer = fs.readFileSync(configurationsJsonPath);

		makeConfigurations = JSON.parse(jsonConfigurationsContent.toString());
	} else {
		logger.message("Configurations file \/.vscode\/make_configurations.json not found");
	}
}

// Last target picked from the set of targets that are run by the makefiles
// when building for the current configuration.
// Saved into the settings storage. Also reflected in the configuration status bar button
let currentTarget: string | undefined;
export function getCurrentTarget(): string | undefined { return currentTarget; }
export function setCurrentTarget(target: string | undefined) { currentTarget = target; }

// Read current target from settings storage, update status bar item
function readCurrentTarget() {
	// If no particular target is defined in settings, use 'Default' for the button
	// but keep the variable empty, to not apend it to the make command.
	let workspaceConfiguration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration();
	currentTarget = workspaceConfiguration.get<string>("Make.buildTarget");
	if (!currentTarget) {
		logger.message("No target defined in the settings file");
		statusBar.setTarget("Default");
		currentTarget = "";
	} else {
		statusBar.setTarget(currentTarget);
	}
}

// Initialization from settings (or backup default rules), done at activation time
export function initFromSettings() {
	readCurrentMakeConfiguration();
	readCurrentMakeConfigurationCommand();
	readCurrentTarget();
	readCurrentLaunchConfiguration();
}

// Fill a drop-down with all the configuration names defined by the user in .vscode\make_configurations.json
// Triggers a cpptools configuration provider update after selection.
export async function setNewConfiguration() {
	// read from the configurations file instead of currentMakefileConfiguration
	// just in case the content changed on disk.
	await readMakeConfigurations();
	const items: string[] = makeConfigurations.map((k => {
		return k.name;
	}));

	const chosen = await vscode.window.showQuickPick(items);
	if (chosen) {
		currentMakeConfiguration = chosen;
		let workspaceConfiguration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration();
		workspaceConfiguration.update("Make.buildConfiguration", currentMakeConfiguration);

		setCurrentMakeConfiguration(currentMakeConfiguration);

		make.dryRun();
	}
}

// Fill a drop-down with all the binaries, with their associated args and executin paths
// as they are parsed from the dry-run output within the scope of
// the current build configuration and the current target.
// Persist the new launch configuration data after the user picks one.
// TODO: deduce also symbol paths.
// TODO: implement UI to collect this information.
// TODO: refactor the dry-run part into make.ts
export async function setNewLaunchConfiguration() {
	let commandArgs: string[] = [];
	// Append --dry-run (to not perform any real build operation),
	// --always-make (to not skip over targets when timestamps indicate nothing needs to be done)
	// and --keep-going (to ensure we get as much info as possible even when some targets fail)
	commandArgs = commandArgs.concat(configurationCommandArgs);
	if (currentTarget) {
		commandArgs.push(currentTarget);
	}
	commandArgs.push("--dry-run");
	commandArgs.push("--always-make");
	commandArgs.push("--keep-going");

	let stdoutStr: string = "";
	let stderrStr: string = "";

	logger.message("Parsing launch configuration for the binaries built by the makefile ... Command: " + configurationCommandName + " " + commandArgs.join(" "));

	let process: child_process.ChildProcess;
	try {
		var stdout = (result: string): void => {
			stdoutStr += result;
		};

		var stderr = (result: string): void => {
			stderrStr += result;
		};

		var closing = (retCode: number, signal: string): void => {
			if (retCode !== 0) {
				logger.message("The verbose make dry-run command for parsing binaries launch configuration failed.");
				logger.message(stderrStr);
			}

			logger.message("The dry-run output for parsing the binaries launch configuration");
			logger.message(stdoutStr);
			let binariesLaunchConfigurations : LaunchConfiguration[] = parser.parseForLaunchConfiguration(stdoutStr);
			selectLaunchConfiguration(binariesLaunchConfigurations);
		};

		await util.spawnChildProcess(configurationCommandName, commandArgs, vscode.workspace.rootPath || "", stdout, stderr, closing);
	} catch (error) {
		logger.message('Failed to launch make command. Make sure it is on the path. ' + error);
		return;
	}
}

// TODO: refactor the dry-run part into make.ts
export async function setNewTarget() {
	let commandArgs: string[] = [];
	// all: must be first argument, to make sure all targets are evaluated and not a subset
	// --dry-run: to ensure no real build is performed for the targets analysis
	// -p: creates a verbose log from which targets are easy to parse
	commandArgs = commandArgs.concat(["all", "--dry-run", "-p"], configurationCommandArgs);
	let stdoutStr: string = "";
	let stderrStr: string = "";

	logger.message("Parsing the targets in the makefile ... Command: " + configurationCommandName + " " + commandArgs.join(" "));

	let process: child_process.ChildProcess;
	try {
		var stdout = (result: string): void => {
			stdoutStr += result;
		};

		var stderr = (result: string): void => {
			stderrStr += result;
		};

		var closing = (retCode: number, signal: string): void => {
			if (retCode !== 0) {
				logger.message("The verbose make dry-run command for parsing targets failed.");
				logger.message(stderrStr);
			}

            // Don't log stdoutStr in this case, because -p output is too verbose to be useful in any logger area
			let makefileTargets : string[] = parser.parseTargets(stdoutStr);
			makefileTargets.sort();
			selectTarget(makefileTargets);
		};

		await util.spawnChildProcess(configurationCommandName, commandArgs, vscode.workspace.rootPath || "", stdout, stderr, closing);
	} catch (error) {
		logger.message('Failed to launch make command. Make sure it is on the path. ' + error);
		return;
	}
}

// Fill a drop-down with all the target names run by building the makefile for the current configuration
// Triggers a cpptools configuration provider update after selection.
// TODO: change the UI list to multiple selections mode and store an array of current active targets
export async function selectTarget(makefileTargets : string[]) {
	const chosen = await vscode.window.showQuickPick(makefileTargets);
	if (chosen) {
		currentTarget = chosen;
		statusBar.setTarget(currentTarget);

		let workspaceConfiguration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration();
		workspaceConfiguration.update("Make.buildTarget", currentTarget);

		make.dryRun();
	}
}

// Fill a drop-down with all the launch configurations found for binaries built by the makefile
// under the scope of the current build configuration and target
// Selection updates current launch configuration that will be ready for the next debug/run operation
export async function selectLaunchConfiguration(launchConfigurations : LaunchConfiguration[]) {
	let items : string[] = [];
	launchConfigurations.forEach(config => {
		items.push(launchConfigurationToString(config));
	});

	items.sort();

	const chosen = await vscode.window.showQuickPick(items);
	if (chosen) {
		statusBar.setLaunchConfiguration(chosen);
		currentLaunchConfiguration = stringToLaunchConfiguration(chosen);
		let workspaceConfiguration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration();
		workspaceConfiguration.update("Make.launchConfiguration", currentLaunchConfiguration);
	}
}


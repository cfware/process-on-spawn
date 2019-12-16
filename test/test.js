'use strict';
const cp = require('child_process');
const {test} = require('tape');
const processOnSpawn = require('..');

const dumpEnvFile = require.resolve('../fixtures/dump-env.js');

function spawn(args, opts) {
	return new Promise((resolve, reject) => {
		const proc = cp.spawn(process.execPath, args, opts);
		const stdout = [];
		const stderr = [];

		proc.stdout.on('data', buf => stdout.push(buf));
		proc.stderr.on('data', buf => stderr.push(buf));

		proc.on('error', reject);
		proc.on('close', status => {
			resolve({
				status,
				stdout: Buffer.concat(stdout).toString(),
				stderr: Buffer.concat(stderr).toString()
			});
		});
	});
}

function spawnSync(args, opts) {
	return cp.spawnSync(process.execPath, args, {
		encoding: 'utf8',
		...opts
	});
}

/* This allows us to filter out if stuff set by other wrappers and avoid leaking
 * sensitive environment. */
const initialEnv = JSON.parse(spawnSync([dumpEnvFile]).stdout);
const clearEnv = JSON.parse(spawnSync([dumpEnvFile], {env: {}}).stdout);

/* Used to verify that we don't trample on process.env */
process.env.TEST_PROCESS_ON_SPAWN = 'added env';

function processResult(t, clear, {status, stdout, stderr}) {
	t.is(status, 0);
	t.is(stderr, '');

	const result = JSON.parse(stdout);
	Object.entries(clear ? clearEnv : initialEnv).forEach(([name, value]) => {
		if (name.startsWith('NYC_') || result[name] === value) {
			delete result[name];
		}
	});

	if (clear) {
		t.notOk('TEST_PROCESS_ON_SPAWN' in result);
	} else {
		t.equal(result.TEST_PROCESS_ON_SPAWN, 'added env');
		delete result.TEST_PROCESS_ON_SPAWN;
	}

	return result;
}

function fixOpts(clear, opts) {
	if (clear) {
		return {
			env: {},
			...opts
		};
	}

	return opts;
}

async function dumpEnv(t, clear = true, opts = {}) {
	return processResult(t, clear, await spawn([dumpEnvFile], fixOpts(clear, opts)));
}

function dumpEnvSync(t, clear = true, opts = {}) {
	return processResult(t, clear, spawnSync([dumpEnvFile], fixOpts(clear, opts)));
}

test('exports', t => {
	t.equal(typeof processOnSpawn, 'object');
	const fns = [
		'addListener',
		'prependListener',
		'removeListener',
		'removeAllListeners'
	];
	t.deepEqual(Object.keys(processOnSpawn).sort(), fns.sort());
	t.deepEqual(
		fns.map(fn => typeof processOnSpawn[fn]),
		fns.map(() => 'function')
	);
	t.end();
});

test('basic tests', async t => {
	const envName = 'SPAWN_MANIPULATE_ENV_VALUE';
	const value = {
		[envName]: 'value1'
	};

	let setValueCalled = 0;
	function setValue({env}) {
		setValueCalled++;
		Object.assign(env, value);
	}

	let appendValueCalled = 0;
	function appendValue(value) {
		return ({env}) => {
			appendValueCalled++;
			env[envName] = (env[envName] || '') + value;
		};
	}

	function checkResults(expectedSets, expectedAppends, expectedDump, dumped) {
		t.deepEqual(dumped, expectedDump);
		t.is(setValueCalled, expectedSets);
		setValueCalled = 0;
		t.is(appendValueCalled, expectedAppends);
		appendValueCalled = 0;
	}

	async function runTests(expectedSets, expectedAppends, expectedDump, opts = {}) {
		checkResults(expectedSets, expectedAppends, expectedDump, await dumpEnv(t, false, opts));
		checkResults(expectedSets, expectedAppends, expectedDump, await dumpEnv(t, true, opts));

		checkResults(expectedSets, expectedAppends, expectedDump, dumpEnvSync(t, false, opts));
		checkResults(expectedSets, expectedAppends, expectedDump, dumpEnvSync(t, true, opts));
	}

	t.doesNotThrow(
		() => processOnSpawn.removeListener(setValue),
		'verify removing non-existent listener does not throw'
	);

	processOnSpawn.addListener(setValue);
	await runTests(1, 0, value);

	processOnSpawn.addListener(appendValue(':value1:'));
	processOnSpawn.addListener(appendValue(':value2:'));
	await runTests(1, 2, {
		[envName]: value[envName] + ':value1::value2:'
	});

	processOnSpawn.addListener(setValue);
	await runTests(2, 2, value);

	/* Removes the first one so setValue is still the last called */
	processOnSpawn.removeListener(setValue);
	await runTests(1, 2, value);

	processOnSpawn.removeListener(setValue);
	processOnSpawn.prependListener(appendValue(':value0:'));
	await runTests(0, 3, {
		[envName]: ':value0::value1::value2:'
	});

	processOnSpawn.removeAllListeners();
	await runTests(0, 0, {});

	let cwd = process.cwd();
	function setOpt(opts, id, value) {
		opts[id] = value;
	}

	function testError(opts) {
		setValueCalled++;

		const {env} = opts;
		t.throws(() => opts.args.push('ignored'), TypeError);
		const optProps = ['env', 'cwd', 'execPath', 'args', 'detached', 'uid', 'gid', 'windowsVerbatimArguments', 'windowsHide'];
		t.deepEqual(Object.keys(opts).sort(), optProps.sort());
		optProps.forEach(id => {
			t.throws(() => setOpt(opts, id, null), TypeError);
			t.throws(() => setOpt(opts, id, 1), TypeError);
			t.throws(() => setOpt(opts, id, true), TypeError);
			t.throws(() => setOpt(opts, id, 'string'), TypeError);
			if (id !== 'env') {
				t.throws(() => setOpt(opts, id, {}), TypeError);
			}
		});

		t.is(opts.env, env);
	}

	function testSuccess(opts) {
		setValueCalled++;
		const replacement = {};
		if ('TEST_PROCESS_ON_SPAWN' in opts.env) {
			replacement.TEST_PROCESS_ON_SPAWN = opts.env.TEST_PROCESS_ON_SPAWN;
		}

		opts.env = replacement;
		t.is(opts.env, replacement);
		t.is(opts.cwd, cwd);
		t.is(opts.execPath, process.execPath);
		t.deepEqual(opts.args, [
			process.execPath,
			dumpEnvFile
		]);
		t.deepEqual(opts.detached, false);
		t.deepEqual(opts.uid, undefined);
		t.deepEqual(opts.gid, undefined);
		t.deepEqual(opts.windowsVerbatimArguments, false);
		t.deepEqual(opts.windowsHide, false);
	}

	processOnSpawn.addListener(testError);
	processOnSpawn.addListener(testSuccess);
	await runTests(2, 0, {});

	cwd = '/';
	await runTests(2, 0, {}, {cwd});
	t.end();
});

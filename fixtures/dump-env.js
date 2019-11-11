#!/usr/bin/env node
'use strict';

const env = {...process.env};
for (const key of Object.keys(env)) {
	if (/^path$/i.test(key)) {
		delete env[key];
	}
}

console.log(JSON.stringify(env));

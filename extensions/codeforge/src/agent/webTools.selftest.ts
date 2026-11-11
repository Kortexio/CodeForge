/**
 * SSRF guards for web_fetch.
 */
import { assertSafeFetchUrlSync, isBlockedFetchHost, isBlockedIp } from './webTools';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

assert(!!assertSafeFetchUrlSync('ftp://example.com'), 'reject non-http');
assert(!!assertSafeFetchUrlSync('http://localhost/admin'), 'reject localhost');
assert(!!assertSafeFetchUrlSync('http://127.0.0.1/'), 'reject loopback');
assert(!!assertSafeFetchUrlSync('http://192.168.1.1/'), 'reject RFC1918');
assert(!!assertSafeFetchUrlSync('http://10.0.0.5/'), 'reject 10/8');
assert(!!assertSafeFetchUrlSync('http://172.16.0.1/'), 'reject 172.16');
assert(!!assertSafeFetchUrlSync('http://169.254.169.254/latest/meta-data/'), 'reject metadata');
assert(!!assertSafeFetchUrlSync('http://[::1]/'), 'reject ipv6 loopback');
assert(!!assertSafeFetchUrlSync('https://user:pass@example.com/'), 'reject credentials');
assert(assertSafeFetchUrlSync('https://example.com/docs') === undefined, 'allow public https');
assert(assertSafeFetchUrlSync('http://example.com/') === undefined, 'allow public http');

assert(isBlockedFetchHost('localhost'), 'host localhost');
assert(isBlockedFetchHost('metadata.google.internal'), 'gcp metadata host');
assert(isBlockedIp('127.0.0.1'), 'ip loopback');
assert(isBlockedIp('169.254.169.254'), 'ip metadata');
assert(!isBlockedIp('8.8.8.8'), 'public dns ok');

console.log('webTools.selftest: ok');

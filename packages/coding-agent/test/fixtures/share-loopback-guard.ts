const configuredOrigin = parseLoopbackOrigin(process.env.OMP_TEST_SHARE_ORIGIN);
const realFetch = globalThis.fetch;

function parseLoopbackOrigin(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		if (
			url.protocol !== "http:" ||
			url.hostname !== "127.0.0.1" ||
			url.port.length === 0 ||
			url.username !== "" ||
			url.password !== "" ||
			url.pathname !== "/" ||
			url.search !== "" ||
			url.hash !== "" ||
			url.origin !== value
		) {
			return undefined;
		}
		return url.origin;
	} catch {
		return undefined;
	}
}

function assertAllowedTarget(input: string | Request | URL): void {
	let target: URL;
	try {
		const href = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
		target = new URL(href);
	} catch {
		throw new Error("Blocked network request: expected the configured loopback share origin");
	}

	if (
		!configuredOrigin ||
		target.protocol !== "http:" ||
		target.username !== "" ||
		target.password !== "" ||
		target.origin !== configuredOrigin
	) {
		throw new Error("Blocked network request: target is not the configured loopback share origin");
	}
}

const guardedPreconnect: typeof realFetch.preconnect = (...args) => {
	assertAllowedTarget(args[0]);
	return realFetch.preconnect(...args);
};

const guardedFetch: typeof globalThis.fetch = Object.assign(
	async (input: string | Request | URL, init?: RequestInit): Promise<Response> => {
		assertAllowedTarget(input);
		return realFetch(input, { ...init, redirect: "error" });
	},
	{ preconnect: guardedPreconnect },
);

globalThis.fetch = guardedFetch;

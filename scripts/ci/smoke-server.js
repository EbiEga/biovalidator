"use strict";

// Runs inside the built container; failure makes image publication fail.
async function main() {
    const base = process.env.SMOKE_URL || 'http://127.0.0.1:3020/biovalidator';
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
        try {
            const response = await fetch(`${base}/ready`, {signal: AbortSignal.timeout(1000)});
            if (response.ok) { ready = true; break; }
        } catch (_) { /* Startup may not yet have opened the port. */ }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error('Server did not become ready');
    const redirect = await fetch(base, {redirect: 'manual'});
    if (redirect.status !== 308) throw new Error('Missing base URL redirect');
    const asset = await fetch(`${base}/assets/ui.min.js`);
    if (!asset.ok) throw new Error('Browser bundle is unavailable');
    for (const [data, valid] of [[42, true], ['wrong', false], [null, false]]) {
        const response = await fetch(`${base}/validate`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({schema: {type: 'number'}, data}),
            signal: AbortSignal.timeout(20_000)
        });
        if (!response.ok) throw new Error(`Validation returned HTTP ${response.status}`);
        const errors = await response.json();
        if (!Array.isArray(errors) || (errors.length === 0) !== valid) throw new Error('Incorrect validation verdict');
    }
    console.log('HTTP, browser assets, and valid/invalid/null validation smoke checks passed.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

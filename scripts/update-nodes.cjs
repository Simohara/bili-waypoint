// Refreshes data/ from the upstream CCB node list; the script itself no longer depends on upstream.
const fs = require('node:fs');
const path = require('node:path');
const base = 'https://raw.githubusercontent.com/Kanda-Akihito-kun/ccb/main/data/';

(async () => {
    for (const name of ['cdn.json', 'region.json', 'info.json']) {
        const response = await fetch(base + name);
        if (!response.ok) throw new Error(name + ': HTTP ' + response.status);
        const data = await response.json(); // a broken download must not replace the snapshot
        fs.writeFileSync(path.join(__dirname, '..', 'data', name), JSON.stringify(data, null, 2) + '\n');
        console.log('Updated data/' + name);
    }
})().catch(error => { console.error(error.message); process.exit(1); });

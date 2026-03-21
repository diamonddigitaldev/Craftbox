const vanilla = require('./vanilla');
const paper = require('./paper');
const folia = require('./folia');
const purpur = require('./purpur');
const fabric = require('./fabric');
const forge = require('./forge');
const neoforge = require('./neoforge');
const custom = require('./custom');

const providers = { vanilla, forge, neoforge, fabric, paper, purpur, folia, custom };

function getProvider(type) {
    return providers[type] || null;
}

function listProviders() {
    return Object.values(providers).map(p => ({
        id: p.id,
        name: p.name,
        description: p.description,
        icon: p.icon,
        logo: p.logo || null
    }));
}

module.exports = { providers, getProvider, listProviders };

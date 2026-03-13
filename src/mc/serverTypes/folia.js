const createPaperApiProvider = require('./_paperApiProvider');

module.exports = createPaperApiProvider({
    project: 'folia',
    id: 'folia',
    name: 'Folia',
    description: 'Multi-threaded Paper fork',
    icon: 'account_tree',
    logo: '/img/server-types/folia.svg'
});

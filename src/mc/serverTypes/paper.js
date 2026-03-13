const createPaperApiProvider = require('./_paperApiProvider');

module.exports = createPaperApiProvider({
    project: 'paper',
    id: 'paper',
    name: 'Paper',
    description: 'Fast, stable plugin server standard',
    icon: 'description',
    logo: '/img/server-types/paper.svg'
});

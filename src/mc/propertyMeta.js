// Metadata for known Minecraft server.properties keys
// Used by the properties editor to render appropriate form fields

const PROPERTY_META = {
    // --- Gameplay ---
    'gamemode': {
        type: 'enum', label: 'Game Mode', group: 'gameplay',
        options: [
            { value: 'survival', label: 'Survival' },
            { value: 'creative', label: 'Creative' },
            { value: 'adventure', label: 'Adventure' },
            { value: 'spectator', label: 'Spectator' }
        ], default: 'survival'
    },
    'difficulty': {
        type: 'enum', label: 'Difficulty', group: 'gameplay',
        options: [
            { value: 'peaceful', label: 'Peaceful' },
            { value: 'easy', label: 'Easy' },
            { value: 'normal', label: 'Normal' },
            { value: 'hard', label: 'Hard' }
        ], default: 'easy'
    },
    'hardcore': { type: 'boolean', label: 'Hardcore', group: 'gameplay', default: 'false', description: 'One life only — world deletes on death' },
    'pvp': { type: 'boolean', label: 'PvP', group: 'gameplay', default: 'true' },
    'max-players': { type: 'number', label: 'Max Players', group: 'gameplay', min: 0, max: 999, default: '20' },
    'force-gamemode': { type: 'boolean', label: 'Force Game Mode', group: 'gameplay', default: 'false', description: 'Force players to join in the default game mode' },
    'allow-flight': { type: 'boolean', label: 'Allow Flight', group: 'gameplay', default: 'false' },
    'spawn-protection': { type: 'number', label: 'Spawn Protection', group: 'gameplay', min: 0, max: 999, default: '16', description: 'Radius in blocks (0 to disable)' },
    'player-idle-timeout': { type: 'number', label: 'Idle Timeout', group: 'gameplay', min: 0, max: 9999, default: '0', description: 'Minutes before idle players are kicked (0 to disable)' },

    // --- World ---
    'level-name': { type: 'string', label: 'World Name', group: 'world', default: 'world' },
    'level-seed': { type: 'string', label: 'World Seed', group: 'world', default: '', description: 'Only applies when generating a new world' },
    'level-type': {
        type: 'enum', label: 'World Type', group: 'world',
        options: [
            { value: 'minecraft\\:normal', label: 'Normal' },
            { value: 'minecraft\\:flat', label: 'Flat' },
            { value: 'minecraft\\:large_biomes', label: 'Large Biomes' },
            { value: 'minecraft\\:amplified', label: 'Amplified' },
            { value: 'minecraft\\:single_biome_surface', label: 'Single Biome' }
        ], default: 'minecraft\\:normal'
    },
    'generate-structures': { type: 'boolean', label: 'Generate Structures', group: 'world', default: 'true' },
    'max-world-size': { type: 'number', label: 'Max World Size', group: 'world', min: 1, max: 29999984, default: '29999984', description: 'World border radius in blocks' },
    'spawn-animals': { type: 'boolean', label: 'Spawn Animals', group: 'world', default: 'true' },
    'spawn-monsters': { type: 'boolean', label: 'Spawn Monsters', group: 'world', default: 'true' },
    'spawn-npcs': { type: 'boolean', label: 'Spawn Villagers', group: 'world', default: 'true' },
    'allow-nether': { type: 'boolean', label: 'Allow Nether', group: 'world', default: 'true' },

    // --- Network ---
    'server-port': { type: 'number', label: 'Server Port', group: 'network', min: 1024, max: 65535, default: '25565' },
    'server-ip': { type: 'string', label: 'Server IP', group: 'network', default: '', description: 'Leave blank to bind all interfaces' },
    'online-mode': { type: 'boolean', label: 'Online Mode', group: 'network', default: 'true', description: 'Verify player accounts with Mojang' },
    'enable-status': { type: 'boolean', label: 'Enable Status', group: 'network', default: 'true', description: 'Show server in multiplayer list' },
    'motd': { type: 'string', label: 'MOTD', group: 'network', default: 'A Minecraft Server', description: 'Message shown in server list' },
    'network-compression-threshold': { type: 'number', label: 'Compression Threshold', group: 'network', min: -1, max: 65535, default: '256', description: 'Bytes (-1 to disable)' },
    'rate-limit': { type: 'number', label: 'Rate Limit', group: 'network', min: 0, max: 99999, default: '0', description: 'Milliseconds between packets (0 to disable)' },
    'max-tick-time': { type: 'number', label: 'Max Tick Time', group: 'network', min: -1, max: 99999999, default: '60000', description: 'Watchdog timeout in ms (-1 to disable)' },

    // --- Performance ---
    'view-distance': { type: 'number', label: 'View Distance', group: 'performance', min: 2, max: 32, default: '10', description: 'Render distance in chunks' },
    'simulation-distance': { type: 'number', label: 'Simulation Distance', group: 'performance', min: 2, max: 32, default: '10', description: 'Ticking distance in chunks' },
    'entity-broadcast-range-percentage': { type: 'number', label: 'Entity Broadcast Range', group: 'performance', min: 10, max: 1000, default: '100', description: 'Percentage of default range' },

    // --- Advanced ---
    'enable-command-block': { type: 'boolean', label: 'Command Blocks', group: 'advanced', default: 'false' },
    'enable-query': { type: 'boolean', label: 'Enable Query', group: 'advanced', default: 'false' },
    'query.port': { type: 'number', label: 'Query Port', group: 'advanced', min: 1, max: 65535, default: '25565' },
    'enable-rcon': { type: 'boolean', label: 'Enable RCON', group: 'advanced', default: 'false' },
    'rcon.port': { type: 'number', label: 'RCON Port', group: 'advanced', min: 1, max: 65535, default: '25575' },
    'rcon.password': { type: 'string', label: 'RCON Password', group: 'advanced', default: '' },
    'white-list': { type: 'boolean', label: 'Whitelist', group: 'advanced', default: 'false' },
    'enforce-whitelist': { type: 'boolean', label: 'Enforce Whitelist', group: 'advanced', default: 'false', description: 'Kick non-whitelisted players on reload' },
    'op-permission-level': { type: 'number', label: 'OP Permission Level', group: 'advanced', min: 1, max: 4, default: '4' },
    'function-permission-level': { type: 'number', label: 'Function Permission Level', group: 'advanced', min: 1, max: 4, default: '2' },
    'log-ips': { type: 'boolean', label: 'Log Player IPs', group: 'advanced', default: 'true' },
};

const GROUPS = [
    { id: 'gameplay', label: 'Gameplay', icon: 'sports_esports' },
    { id: 'world', label: 'World', icon: 'public' },
    { id: 'network', label: 'Network', icon: 'wifi' },
    { id: 'performance', label: 'Performance', icon: 'speed' },
    { id: 'advanced', label: 'Advanced', icon: 'settings' },
];

module.exports = { PROPERTY_META, GROUPS };

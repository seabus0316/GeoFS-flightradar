const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const sourceDir = path.join(rootDir, 'node_modules', 'cesium', 'Build', 'Cesium');
const targetDir = path.join(rootDir, 'public', 'cesium');

if (!fs.existsSync(sourceDir)) {
  console.error(`Cesium build not found: ${sourceDir}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(targetDir), { recursive: true });
fs.cpSync(sourceDir, targetDir, { recursive: true, force: true });

console.log(`Synced Cesium assets to ${targetDir}`);

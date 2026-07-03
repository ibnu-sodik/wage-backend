const fs = require('fs');
const yaml = require('js-yaml');

const yamlContent = fs.readFileSync('insomnia-collection.yaml', 'utf8');
const data = yaml.load(yamlContent);

// Convert any Date objects to ISO strings
function convertDates(obj) {
  if (obj instanceof Date) {
    return obj.toISOString();
  }
  if (Array.isArray(obj)) {
    return obj.map(convertDates);
  }
  if (obj && typeof obj === 'object') {
    const result = {};
    for (const key in obj) {
      result[key] = convertDates(obj[key]);
    }
    return result;
  }
  return obj;
}

const jsonData = convertDates(data);
fs.writeFileSync('insomnia-collection.json', JSON.stringify(jsonData, null, 2));
console.log('✓ Converted insomnia-collection.yaml → insomnia-collection.json');
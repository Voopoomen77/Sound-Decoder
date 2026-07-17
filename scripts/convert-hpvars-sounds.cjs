const fs = require('fs')
const path = require('path')

const [, , inputPath, outputPath = 'hpvars-sounds.json'] = process.argv

if (!inputPath) {
	console.error('Usage: node scripts/convert-hpvars-sounds.cjs <input.txt> [output.json]')
	process.exit(1)
}

const sourcePath = path.resolve(inputPath)
const targetPath = path.resolve(outputPath)
const source = fs.readFileSync(sourcePath, 'utf8')
const HPVARS = {}
const soundsObject = Function(
	'HPVARS',
	`"use strict";\n${source}\nreturn HPVARS.SOUNDS;`,
)(HPVARS)

if (!soundsObject || typeof soundsObject !== 'object') {
	throw new Error('HPVARS.SOUNDS was not found in the input file.')
}

const sounds = Object.entries(soundsObject).map(([id, value]) => ({
	id,
	volume: typeof value.volume === 'number' ? value.volume : undefined,
	base64: value.base64,
}))

fs.writeFileSync(targetPath, `${JSON.stringify({ sounds }, null, 2)}\n`)
console.log(`Converted ${sounds.length} sounds to ${targetPath}`)

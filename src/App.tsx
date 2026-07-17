import { useMemo, useRef, useState } from 'react'
import './App.css'

type SoundStatus = 'valid' | 'invalid'

interface DecodedSound {
	id: string
	status: SoundStatus
	sourceKey: string
	size: number
	volume?: number
	type?: string
	url?: string
	base64?: string
	reason?: string
}

type RawEntry = {
	id?: unknown
	name?: unknown
	key?: unknown
	title?: unknown
	data?: unknown
	base64?: unknown
	sound?: unknown
	audio?: unknown
	content?: unknown
	mime?: unknown
	type?: unknown
	volume?: unknown
}

const AUDIO_SIGNATURES = [
	{
		type: 'audio/wav',
		extension: 'wav',
		matches: (bytes: Uint8Array) =>
			hasAscii(bytes, 0, 'RIFF') && hasAscii(bytes, 8, 'WAVE'),
	},
	{
		type: 'audio/mpeg',
		extension: 'mp3',
		matches: (bytes: Uint8Array) =>
			hasAscii(bytes, 0, 'ID3') ||
			(bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0),
	},
	{
		type: 'audio/ogg',
		extension: 'ogg',
		matches: (bytes: Uint8Array) => hasAscii(bytes, 0, 'OggS'),
	},
	{
		type: 'audio/flac',
		extension: 'flac',
		matches: (bytes: Uint8Array) => hasAscii(bytes, 0, 'fLaC'),
	},
	{
		type: 'audio/mp4',
		extension: 'm4a',
		matches: (bytes: Uint8Array) => hasAscii(bytes, 4, 'ftyp'),
	},
	{
		type: 'audio/webm',
		extension: 'webm',
		matches: (bytes: Uint8Array) =>
			bytes[0] === 0x1a &&
			bytes[1] === 0x45 &&
			bytes[2] === 0xdf &&
			bytes[3] === 0xa3,
	},
]

const BLOCKED_SIGNATURES = [
	{ label: 'PNG-картинка', matches: (bytes: Uint8Array) => hasAscii(bytes, 1, 'PNG') },
	{ label: 'JPEG-картинка', matches: (bytes: Uint8Array) => bytes[0] === 0xff && bytes[1] === 0xd8 },
	{ label: 'GIF-картинка', matches: (bytes: Uint8Array) => hasAscii(bytes, 0, 'GIF') },
	{ label: 'WebP-картинка', matches: (bytes: Uint8Array) => hasAscii(bytes, 8, 'WEBP') },
	{ label: 'PDF-документ', matches: (bytes: Uint8Array) => hasAscii(bytes, 0, '%PDF') },
	{ label: 'ZIP-архив', matches: (bytes: Uint8Array) => hasAscii(bytes, 0, 'PK') },
]

function hasAscii(bytes: Uint8Array, offset: number, value: string) {
	if (bytes.length < offset + value.length) return false

	return [...value].every((char, index) => bytes[offset + index] === char.charCodeAt(0))
}

function formatBytes(bytes: number) {
	if (!bytes) return '0 B'

	const units = ['B', 'KB', 'MB', 'GB']
	const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
	const value = bytes / 1024 ** power

	return `${value.toFixed(value >= 10 || power === 0 ? 0 : 1)} ${units[power]}`
}

function cleanBase64(value: string) {
	const trimmed = value.trim()
	const dataUriMatch = trimmed.match(/^data:([^;,]+)?;base64,(.+)$/i)

	return {
		mime: dataUriMatch?.[1],
		base64: (dataUriMatch?.[2] ?? trimmed).replace(/\s/g, ''),
	}
}

function clampVolume(value: unknown) {
	if (typeof value !== 'number' || !Number.isFinite(value)) return undefined

	return Math.min(1, Math.max(0, value))
}

function parseInput(text: string) {
	try {
		return JSON.parse(text) as unknown
	} catch {
		const scope = { HPVARS: {} as { SOUNDS?: unknown } }
		const readHpvarsSounds = new Function(
			'HPVARS',
			`"use strict";\n${text}\nreturn HPVARS.SOUNDS;`,
		) as (hpvars: typeof scope.HPVARS) => unknown

		const sounds = readHpvarsSounds(scope.HPVARS)

		if (!sounds) {
			throw new Error('HPVARS.SOUNDS was not found')
		}

		return sounds
	}
}

function decodeBase64(base64: string) {
	const normalized = base64.replace(/-/g, '+').replace(/_/g, '/')
	const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
	const binary = atob(padded)
	const bytes = new Uint8Array(binary.length)

	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index)
	}

	return bytes
}

function detectAudio(bytes: Uint8Array) {
	const blocked = BLOCKED_SIGNATURES.find(signature => signature.matches(bytes))

	if (blocked) {
		return { ok: false as const, reason: `Это похоже на ${blocked.label}, не на звук.` }
	}

	const audio = AUDIO_SIGNATURES.find(signature => signature.matches(bytes))

	if (!audio) {
		return {
			ok: false as const,
			reason: 'Не найдена аудио-сигнатура. Поддерживаются MP3, WAV, OGG, FLAC, M4A/MP4 и WebM.',
		}
	}

	return { ok: true as const, ...audio }
}

function extractEntries(json: unknown): Array<{ sourceKey: string; value: RawEntry | string }> {
	if (Array.isArray(json)) {
		return json.map((value, index) => ({ sourceKey: `#${index + 1}`, value }))
	}

	if (json && typeof json === 'object') {
		const object = json as Record<string, unknown>

		for (const key of ['sounds', 'audio', 'items', 'files']) {
			if (Array.isArray(object[key])) {
				return object[key].map((value, index) => ({
					sourceKey: `${key}[${index}]`,
					value,
				}))
			}
		}

		return Object.entries(object).map(([sourceKey, value]) => ({ sourceKey, value: value as RawEntry | string }))
	}

	return []
}

function normalizeEntry(entry: RawEntry | string, sourceKey: string, index: number) {
	if (typeof entry === 'string') {
		return { id: sourceKey || `sound-${index + 1}`, data: entry, mime: undefined, volume: undefined }
	}

	if (!entry || typeof entry !== 'object') {
		return null
	}

	const id =
		firstString(entry.id, entry.name, entry.key, entry.title) ?? sourceKey ?? `sound-${index + 1}`
	const data = firstString(entry.data, entry.base64, entry.sound, entry.audio, entry.content)
	const mime = firstString(entry.mime, entry.type)
	const volume = clampVolume(entry.volume)

	if (!data) {
		return { id, data: null, mime, volume }
	}

	return { id, data, mime, volume }
}

function firstString(...values: unknown[]) {
	return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)
}

function parseSounds(json: unknown) {
	const entries = extractEntries(json)

	return entries.map(({ sourceKey, value }, index): DecodedSound => {
		const normalized = normalizeEntry(value, sourceKey, index)

		if (!normalized) {
			return {
				id: sourceKey || `entry-${index + 1}`,
				sourceKey,
				status: 'invalid',
				size: 0,
				reason: 'Запись должна быть строкой base64 или объектом с полем data/base64/audio/sound.',
			}
		}

		if (!normalized.data) {
			return {
				id: normalized.id,
				sourceKey,
				status: 'invalid',
				size: 0,
				reason: 'В записи не найдено поле с base64-данными.',
			}
		}

		try {
			const cleaned = cleanBase64(normalized.data)
			const bytes = decodeBase64(cleaned.base64)
			const detected = detectAudio(bytes)

			if (!detected.ok) {
				return {
					id: normalized.id,
					sourceKey,
					status: 'invalid',
					size: bytes.length,
					reason: detected.reason,
				}
			}

			const type = cleaned.mime?.startsWith('audio/') ? cleaned.mime : normalized.mime ?? detected.type
			const blob = new Blob([bytes], { type })

			return {
				id: normalized.id,
				sourceKey,
				status: 'valid',
				size: bytes.length,
				volume: normalized.volume,
				type,
				base64: cleaned.base64,
				url: URL.createObjectURL(blob),
			}
		} catch {
			return {
				id: normalized.id,
				sourceKey,
				status: 'invalid',
				size: 0,
				reason: 'Base64 не удалось декодировать. Проверьте, что строка не повреждена.',
			}
		}
	})
}

export default function App() {
	const [sounds, setSounds] = useState<DecodedSound[]>([])
	const [query, setQuery] = useState('')
	const [showInvalid, setShowInvalid] = useState(true)
	const [fileName, setFileName] = useState('')
	const [notice, setNotice] = useState('Загрузите JSON, чтобы начать.')
	const audioRef = useRef<HTMLAudioElement | null>(null)
	const urlsRef = useRef<string[]>([])

	const validSounds = sounds.filter(sound => sound.status === 'valid')
	const invalidSounds = sounds.filter(sound => sound.status === 'invalid')

	const filteredSounds = useMemo(() => {
		const normalizedQuery = query.trim().toLowerCase()

		return sounds.filter(sound => {
			const matchesQuery = sound.id.toLowerCase().includes(normalizedQuery)
			const matchesStatus = showInvalid || sound.status === 'valid'

			return matchesQuery && matchesStatus
		})
	}, [query, showInvalid, sounds])

	const revokeUrls = () => {
		urlsRef.current.forEach(url => URL.revokeObjectURL(url))
		urlsRef.current = []
	}

	const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0]

		if (!file) return

		revokeUrls()
		setFileName(file.name)

		try {
			const text = await file.text()
			const json = parseInput(text)
			const parsedSounds = parseSounds(json)
			const urls = parsedSounds.flatMap(sound => (sound.url ? [sound.url] : []))

			urlsRef.current = urls
			setSounds(parsedSounds)
			setNotice(
				parsedSounds.length
					? `Готово: ${parsedSounds.filter(sound => sound.status === 'valid').length} звуков, ${parsedSounds.filter(sound => sound.status === 'invalid').length} отклонено.`
					: 'В JSON не найдено записей со звуками.',
			)
		} catch {
			setSounds([])
			setNotice('JSON не удалось прочитать. Проверьте синтаксис файла.')
		} finally {
			event.target.value = ''
		}
	}

	const copyName = async (name: string) => {
		await navigator.clipboard.writeText(name)
		setNotice(`Название скопировано: ${name}`)
	}

	const handlePlay = (event: React.SyntheticEvent<HTMLAudioElement>) => {
		const current = event.currentTarget

		if (audioRef.current && audioRef.current !== current) {
			audioRef.current.pause()
			audioRef.current.currentTime = 0
		}

		audioRef.current = current
		current.volume = Number(current.dataset.volume ?? 1)
	}

	const handleAudioLoadedMetadata = (event: React.SyntheticEvent<HTMLAudioElement>) => {
		event.currentTarget.volume = Number(event.currentTarget.dataset.volume ?? 1)
	}

	const exportSound = (sound: DecodedSound) => {
		if (!sound.url) return

		const extension =
			AUDIO_SIGNATURES.find(signature => signature.type === sound.type)?.extension ??
			sound.type?.split('/')[1] ??
			'audio'
		const link = document.createElement('a')

		link.href = sound.url
		link.download = `${sound.id.replace(/[\\/:*?"<>|]/g, '_')}.${extension}`
		link.click()
	}

	return (
		<main className='app-shell'>
			<section className='hero-panel'>
				<div>
					<p className='eyebrow'>Base64 JSON Audio Decoder</p>
					<h1>Профессиональный декодер звуков</h1>
					<p className='lead'>
						Загрузите JSON с base64 — приложение покажет только настоящие аудиофайлы,
						отсеет картинки и битые записи, даст прослушать, скопировать имя и выгрузить
						звук обратно файлом.
					</p>
				</div>

				<label className='drop-zone'>
					<input type='file' accept='application/json,.json,.js,.txt' onChange={handleFileUpload} />
					<span>Выбрать JSON</span>
					<small>{fileName || 'Поддержка: JSON, HPVARS.SOUNDS, volume и base64'}</small>
				</label>
			</section>

			<section className='toolbar' aria-label='Фильтры'>
				<input
					type='search'
					placeholder='Быстрый поиск по названию...'
					value={query}
					onChange={event => setQuery(event.target.value)}
				/>

				<label className='toggle'>
					<input
						type='checkbox'
						checked={showInvalid}
						onChange={event => setShowInvalid(event.target.checked)}
					/>
					Показывать отклонённые
				</label>
			</section>

			<section className='stats-grid' aria-label='Статистика'>
				<div>
					<strong>{sounds.length}</strong>
					<span>записей</span>
				</div>
				<div>
					<strong>{validSounds.length}</strong>
					<span>звуков</span>
				</div>
				<div>
					<strong>{invalidSounds.length}</strong>
					<span>отклонено</span>
				</div>
				<div>
					<strong>{formatBytes(validSounds.reduce((sum, sound) => sum + sound.size, 0))}</strong>
					<span>аудио-данных</span>
				</div>
			</section>

			<p className='notice' role='status'>
				{notice}
			</p>

			<section className='sound-list'>
				{filteredSounds.length === 0 ? (
					<div className='empty-state'>
						<h2>Пока нечего показывать</h2>
						<p>Загрузите JSON или измените фильтр поиска.</p>
					</div>
				) : (
					filteredSounds.map(sound => (
						<article className={`sound-card ${sound.status}`} key={`${sound.sourceKey}-${sound.id}`}>
							<div className='sound-meta'>
								<button
									className='sound-name'
									type='button'
									title='Скопировать название'
									onClick={() => void copyName(sound.id)}
								>
									{sound.id}
								</button>

								<div className='badges'>
									<span>{sound.status === 'valid' ? 'audio' : 'rejected'}</span>
									{sound.type && <span>{sound.type}</span>}
									<span>{formatBytes(sound.size)}</span>
									{typeof sound.volume === 'number' && <span>{Math.round(sound.volume * 100)}%</span>}
								</div>
							</div>

							{sound.status === 'valid' && sound.url ? (
								<div className='player-row'>
									<audio
										controls
										data-volume={sound.volume ?? 1}
										preload='metadata'
										src={sound.url}
										onLoadedMetadata={handleAudioLoadedMetadata}
										onPlay={handlePlay}
									>
										Ваш браузер не поддерживает audio.
									</audio>
									<button type='button' className='secondary-button' onClick={() => exportSound(sound)}>
										Скачать
									</button>
								</div>
							) : (
								<p className='reason'>{sound.reason}</p>
							)}
						</article>
					))
				)}
			</section>
		</main>
	)
}

import {
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    proto
} from '@whiskeysockets/baileys'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { addMetadata } from './metadata'

const execFileAsync = promisify(execFile)

const MAX_SECONDS = 10
const MAX_STICKER_BYTES = 500 * 1024

const tag = (field: number) => (field << 3) | 2
const AUDIO_STICKER_TAG = tag(134)
const FUTURE_PROOF_MESSAGE_TAG = tag(1)
const STICKER_TAG = tag(26)
const STICKER_AUDIO_TAG = tag(26)

let patched = false

export function installSoundStickerPatch() {
    if (patched) return
    patched = true

    const Message = proto.Message as any
    const originalEncode = Message.encode

    Message.encode = function (message: any, writer?: any) {
        const sticker = message?.stickerMessage

        if (!sticker?.soundAudio) {
            return originalEncode.call(this, message, writer)
        }

        const output = originalEncode.call(this, { ...message, stickerMessage: null }, writer)

        output.uint32(AUDIO_STICKER_TAG).fork()
        output.uint32(FUTURE_PROOF_MESSAGE_TAG).fork()
        output.uint32(STICKER_TAG).fork()
        Message.StickerMessage.encode(sticker, output)
        output.uint32(STICKER_AUDIO_TAG).bytes(sticker.soundAudio)
        output.ldelim().ldelim().ldelim()

        return output
    }
}

async function probeVideo(file: string) {
    const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-show_entries', 'stream=codec_type',
        '-of', 'json',
        file
    ])

    const info = JSON.parse(stdout)
    const duration = Number(info.format?.duration)
    const hasAudio = info.streams?.some(
        (stream: any) => stream.codec_type === 'audio'
    )

    if (!hasAudio) {
        throw new Error('O vídeo não possui áudio.')
    }

    if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error('Não foi possível identificar a duração do vídeo.')
    }

    return Math.min(duration, MAX_SECONDS)
}

async function convertSticker(input: string, webp: string, duration: number) {
    const settings = [
        { fps: 15, quality: 50, detail: 512 },
        { fps: 12, quality: 45, detail: 512 },
        { fps: 10, quality: 40, detail: 480 },
        { fps: 8, quality: 35, detail: 420 },
        { fps: 8, quality: 30, detail: 360 },
        { fps: 7, quality: 25, detail: 320 },
        { fps: 6, quality: 20, detail: 320 },
        { fps: 5, quality: 15, detail: 288 },
        { fps: 5, quality: 10, detail: 256 },
        { fps: 4, quality: 8, detail: 224 }
    ]

    for (const { fps, quality, detail } of settings) {
        await execFileAsync('ffmpeg', [
            '-y',
            '-i', input,
            '-t', String(duration),
            '-map', '0:v:0',
            '-an',
            '-vf',
            [
                `fps=${fps}`,
                `scale=${detail}:${detail}:force_original_aspect_ratio=decrease`,
                'scale=iw*512/max(iw\\,ih):ih*512/max(iw\\,ih)',
                'format=rgba',
                'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black@0'
            ].join(','),
            '-c:v', 'libwebp_anim',
            '-lossless', '0',
            '-q:v', String(quality),
            '-compression_level', '4',
            '-loop', '0',
            webp
        ])

        if (fs.statSync(webp).size <= MAX_STICKER_BYTES) return
    }

    throw new Error(`Não foi possível gerar a figurinha dentro de 500 KB. Tamanho: ${fs.statSync(webp).size} bytes.`)
}

async function convertAudio(input: string, ogg: string, duration: number) {
    await execFileAsync('ffmpeg', [
        '-y',
        '-i', input,
        '-t', String(duration),
        '-map', '0:a:0',
        '-vn',
        '-map_metadata', '-1',
        '-af', `aresample=48000:async=1:first_pts=0,apad=whole_dur=${duration}`,
        '-ac', '1',
        '-ar', '48000',
        '-c:a', 'libopus',
        '-b:a', '64k',
        '-f', 'ogg',
        ogg
    ])
}

export async function createSoundSticker(
    sock: any,
    jid: string,
    video: Buffer,
    quoted: any
) {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'bot-figurinha-')
    )

    const input = path.join(directory, 'input.mp4')
    const webp = path.join(directory, 'sticker.webp')
    const ogg = path.join(directory, 'audio.ogg')

    try {
        fs.writeFileSync(input, video)

        const duration = await probeVideo(input)

        await convertSticker(input, webp, duration)
        await convertAudio(input, ogg, duration)

        const uploadOptions = {
            upload: sock.waUploadToServer
        }

        const { audioMessage } = await prepareWAMessageMedia(
            {
                audio: fs.readFileSync(ogg),
                mimetype: 'audio/ogg; codecs=opus',
                seconds: Math.max(1, Math.round(duration)),
                ptt: false
            },
            uploadOptions
        )

        const { stickerMessage } = await prepareWAMessageMedia(
            {
                sticker: await addMetadata(fs.readFileSync(webp)),
                isAnimated: true,
                width: 512,
                height: 512
            },
            uploadOptions
        )

        const message = generateWAMessageFromContent(
            jid,
            { stickerMessage: stickerMessage as any },
            {
                quoted,
                userJid: sock.user?.id
            }
        )

        const sticker = message.message!.stickerMessage as any
        sticker.soundAudio = proto.Message.AudioMessage.encode(audioMessage!).finish()

        await sock.relayMessage(
            jid,
            message.message,
            {
                messageId: message.key.id
            }
        )
    } finally {
        fs.rmSync(directory, {
            recursive: true,
            force: true
        })
    }
}
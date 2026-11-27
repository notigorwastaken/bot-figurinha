import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    downloadMediaMessage,
    normalizeMessageContent,
    GroupMetadata,
    makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import P from 'pino'
import qrcode from 'qrcode-terminal'
import sharp from 'sharp'
import { createSoundSticker, installSoundStickerPatch } from './sound-sticker.js'
import { MediaQueue } from './media-queue.js'
import NodeCache from '@cacheable/node-cache'
import { startServer } from './express/index.js'

const logger = P({ level: 'silent' })
installSoundStickerPatch()
export const groupCache = new NodeCache<GroupMetadata>({ stdTTL: 5 * 60, useClones: false })
const mediaQueue = new MediaQueue(500)

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')

    const sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        cachedGroupMetadata: async (jid: string) => groupCache.get(jid) as any,
    })

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            qrcode.generate(qr, { small: true })
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut

            if (shouldReconnect) {
                connectToWhatsApp()
            } else {
                console.log('Logged out. Delete the auth folder and re-scan to reconnect.')
            }
        } else if (connection === 'open') {
            console.log('Connected to WhatsApp')
        }
    })

    sock.ev.on('call', async (calls) => {
        for (const call of calls) {
            if (call.status !== 'offer') continue

            await sock.rejectCall(call.id, call.from).catch(console.error)
        }
    })
    sock.ev.on('groups.update', async ([event]) => {
        const id = (event as { id: string }).id as string;
        const metadata = await sock.groupMetadata(id)
        groupCache.set(id, metadata)
    })

    sock.ev.on('group-participants.update', async (event: any) => {
        const id = (event as { id: string }).id as string;
        const metadata = await sock.groupMetadata(id)
        groupCache.set(id, metadata)
    })
    sock.ev.on('messages.upsert', (event) => {
        if (event.type !== 'notify') return

        for (const m of event.messages) {
            if (m.key.fromMe) continue

            const jid = m.key.remoteJid

            if (!jid || jid === 'status@broadcast') continue

            const content = normalizeMessageContent(m.message)

            console.log('[DEBUG] Tipo de mensagem:', Object.keys(content ?? {}))
            console.log('[DEBUG] Tipo original:', Object.keys(m.message ?? {}))

            if (!content) continue

            const isVideo = Boolean(content.videoMessage)
            const isImage = Boolean(content.imageMessage)

            if (!isVideo && !isImage) continue

            if (!m.key.id) {
                console.warn('Media message ignored because it has no message ID:', jid)
                continue
            }

            const result = mediaQueue.enqueue(`${jid}:${m.key.id}`, async () => {
                if (isVideo) {
                    console.log('Video received from:', jid)

                    const media = await downloadMediaMessage(
                        m,
                        'buffer',
                        {}
                    ) as Buffer

                    await createSoundSticker(sock, jid, media, m)

                    console.log('Sound sticker sent successfully!')
                    return
                }

                console.log('Image received from:', jid)

                const media = await downloadMediaMessage(
                    m,
                    'buffer',
                    {}
                ) as Buffer

                const sticker = await sharp(media)
                    .rotate()
                    .resize(512, 512, {
                        fit: 'contain',
                        background: {
                            r: 0,
                            g: 0,
                            b: 0,
                            alpha: 0
                        }
                    })
                    .webp({
                        quality: 80,
                        effort: 5
                    })
                    .toBuffer()

                await sock.sendMessage(
                    jid,
                    {
                        sticker
                    },
                    {
                        quoted: m
                    }
                )

                console.log('Sticker sent successfully!')
            })

            if (result === 'duplicate') {
                console.log('Duplicate media message ignored:', m.key.id)
            } else if (result === 'full') {
                console.warn('Media queue is full. Message ignored:', m.key.id)
            }
        }
    })

    sock.ev.on('creds.update', saveCreds)
    await startServer(groupCache, sock);
}

connectToWhatsApp()

process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED REJECTION]', reason);
});

process.on('uncaughtException', (error) => {
    console.error('[UNCAUGHT EXCEPTION]', error);

    process.exit(1);
});
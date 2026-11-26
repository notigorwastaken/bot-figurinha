
import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    downloadMediaMessage,
    normalizeMessageContent
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import qrcode from 'qrcode-terminal'
import sharp from 'sharp'
import { createSoundSticker, installSoundStickerPatch } from './sound-sticker.js'

installSoundStickerPatch()

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')

    const sock = makeWASocket({
        auth: state
    })

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            qrcode.generate(qr, { small: true })
        }

        if (connection === 'close') {
            const shouldReconnect =
                (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut

            console.log('Connection closed:', lastDisconnect?.error)

            if (shouldReconnect) {
                connectToWhatsApp()
            }
        } else if (connection === 'open') {
            console.log('WhatsApp connected!')
        }
    })
    sock.ev.on('call', async (calls) => {
        for (const call of calls) {
            if (call.status !== 'offer') continue

            await sock.rejectCall(call.id, call.from).catch(console.error)
        }
    })
    sock.ev.on('messages.upsert', async (event) => {
        if (event.type !== 'notify') return

        for (const m of event.messages) {
            if (m.key.fromMe) continue

            const jid = m.key.remoteJid

            if (!jid || jid === 'status@broadcast') continue

            const content = normalizeMessageContent(m.message)
            console.log('[DEBUG] Tipo de mensagem:', Object.keys(content ?? {}))
            console.log('[DEBUG] Tipo original:', Object.keys(m.message ?? {}))
            if (!content) continue

            try {
                if (content.videoMessage) {
                    console.log('Video received from:', jid)

                    const media = await downloadMediaMessage(
                        m,
                        'buffer',
                        {}
                    ) as Buffer

                    await createSoundSticker(sock, jid, media, m)

                    console.log('Sound sticker sent successfully!')
                    continue
                }

                if (!content.imageMessage) continue

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
            } catch (error) {
                console.error('Error processing media:', error)
            }
        }
    })

    sock.ev.on('creds.update', saveCreds)
}

connectToWhatsApp()

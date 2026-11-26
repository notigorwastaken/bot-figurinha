import webpmux from 'node-webpmux'

const PACK_NAME = 'Pacote do Igor Figurinhas'
const AUTHOR = '@acervo_do_igor (instagram)'

export async function addMetadata(sticker: Buffer): Promise<Buffer> {
    const json = Buffer.from(
        JSON.stringify({
            'sticker-pack-id': 'igorbot-figurinha',
            'sticker-pack-name': PACK_NAME,
            'sticker-pack-publisher': AUTHOR,
            emojis: ['🔥']
        })
    )

    const header = Buffer.from([
        0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
        0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x16, 0x00, 0x00, 0x00
    ])

    header.writeUInt32LE(json.length, 14)

    const image = new webpmux.Image()

    await image.load(sticker)
    image.exif = Buffer.concat([header, json])

    return await image.save(null)
}
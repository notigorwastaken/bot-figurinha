type QueueTask = () => Promise<void>

type QueueItem = {
    key: string
    task: QueueTask
}

export type EnqueueResult = 'queued' | 'duplicate' | 'full'

export class MediaQueue {
    private readonly pending: QueueItem[] = []
    private readonly seen = new Map<string, number>()
    private running = false

    constructor(
        private readonly maxPending = 50,
        private readonly deduplicationTtl = 24 * 60 * 60 * 1000,
        private readonly maxTrackedMessages = 10_000
    ) {}

    enqueue(key: string, task: QueueTask): EnqueueResult {
        this.cleanExpired()

        if (this.seen.has(key)) {
            return 'duplicate'
        }

        if (this.pending.length >= this.maxPending) {
            return 'full'
        }

        this.seen.set(key, Date.now())
        this.pending.push({ key, task })

        void this.process()

        return 'queued'
    }

    private cleanExpired() {
        const now = Date.now()

        for (const [key, timestamp] of this.seen) {
            if (now - timestamp >= this.deduplicationTtl) {
                this.seen.delete(key)
            }
        }

        while (this.seen.size > this.maxTrackedMessages) {
            const oldestKey = this.seen.keys().next().value

            if (oldestKey === undefined) break

            this.seen.delete(oldestKey)
        }
    }

    private async process() {
        if (this.running) return

        this.running = true

        try {
            while (this.pending.length > 0) {
                const item = this.pending.shift()

                if (!item) continue

                try {
                    await item.task()
                } catch (error) {
                    this.seen.delete(item.key)
                    console.error('Queue task failed:', error)
                }
            }
        } finally {
            this.running = false

            if (this.pending.length > 0) {
                void this.process()
            }
        }
    }
}


import express, { Express, Request, Response, NextFunction } from 'express';
import NodeCache from '@cacheable/node-cache';
import { GroupMetadata, WASocket } from '@whiskeysockets/baileys';

export function createServer(
    groupCache: NodeCache<GroupMetadata>,
    sock: WASocket
): Express {
    const app = express();

    app.use(express.json());

    const token = process.env.DASHBOARD_TOKEN;

    app.use('/api', (req: Request, res: Response, next: NextFunction) => {
        if (!token) {
            return res.status(503).json({
                error: 'Dashboard token not configured'
            });
        }

        const authorization = req.headers.authorization;

        if (authorization !== `Bearer ${token}`) {
            return res.status(401).json({
                error: 'Unauthorized'
            });
        }

        next();
    });

    app.get('/', (_req, res) => {
        const name = sock.user?.name ?? 'Unknown';
        res.json({
            name: `${name} - Dashboard`,
            status: sock.user ? 'running' : 'not running'
        });
    });

    app.get('/api/status', (_req, res) => {
        res.json({
            connected: sock.user !== undefined,
            name: sock.user?.name ?? null,
            jid: sock.user?.id ?? null
        });
    });

    app.get('/api/groups', (_req, res) => {
        const groups = groupCache.keys().map(jid => {
            const metadata = groupCache.get(jid);

            if (!metadata) return null;

            return {
                id: jid,
                subject: metadata.subject,
                participants: metadata.participants.length
            };
        }).filter(Boolean);

        res.json({
            total: groups.length,
            groups
        });
    });

    return app;
}

export async function startServer(
    groupCache: NodeCache<GroupMetadata>,
    sock: WASocket
) {
    const app = createServer(groupCache, sock);
    const port = Number(process.env.PORT) || 3000;

    return app.listen(port, '0.0.0.0', () => {
        console.log(`Dashboard running on port ${port}`);
    });
}

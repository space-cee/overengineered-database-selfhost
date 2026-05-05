import { Elysia, t } from 'elysia';
import { DatabaseInteractions } from './DatabaseInteractions';
import { Database } from "bun:sqlite";
import { write_token } from '../Access Tokens/securityTokens';

export namespace HttpHandler {
    export const init = (db: Database, base: string, port: number) => {
        const app = new Elysia();
        app.listen(port);

        // read player data by id
        app.get(`/${base}/player/:id`, ({ params: { id } }) => {
            const player = DatabaseInteractions.getDataEntryByID(db, id);
            return player ?? { error: 'Not found' };
        });

        // read all saves by player id
        app.get(`/${base}/save/:id`, ({ params: { id } }) => {
            const saves = DatabaseInteractions.getSavesOfPlayerByID(db, id);
            return saves ? ({ saves }) : { error: 'Not found' };
        });

        // read single save by player id
        app.get(`/${base}/save/:id/:index`, ({ params: { id, index } }) => {
            const save = DatabaseInteractions.getSavesOfPlayerByIDWithIndex(db, id, index);
            return save ?? { error: 'Not found' };
        });

        // write player
        app.post(`/${base}/player`, ({ body }) => {
            if (body.token !== write_token) return { error: "incorrect token" };
            DatabaseInteractions.insertPlayers(db, [body]);
            return { status: 'ok' };
        }, {
            body: t.Object({
                playerID: t.String(),
                data: t.String(),
                token: t.String(),
            })
        });

        // write save (I'm not doing batches)
        app.post(`/${base}/save`, ({ body }) => {
            if (body.token !== write_token) return { error: "incorrect token" };
            DatabaseInteractions.insertSave(db, [body]);
            return { status: 'ok' };
        }, {
            body: t.Object({
                playerID: t.String(),
                index: t.String(),
                data: t.String(),
                token: t.String(),
            })
        });

        console.log(`HTTP is running on http://localhost:${port}`);
    }
}
export type BaseEventInfo = {
    uuid: string,
    timestamp: number,
    data: Object
}

const timeout_ms = 30 * 60 * 1000;
const cachedEvents: BaseEventInfo[] = [];

export namespace GameEventsHandler
{
    export const addEvent = (data: BaseEventInfo["data"]) =>
    {
        cachedEvents.unshift({
            uuid: crypto.randomUUID(),
            timestamp: Date.now(),
            data,
        });

        const oldestEvent = cachedEvents.at(-1);

        if (oldestEvent) {
            const timePassed = Date.now() - oldestEvent.timestamp;
            if (timePassed > timeout_ms) cachedEvents.pop();
        }

        // left here just in case
        // setTimeout(() => cachedEvents.pop(), timeout_ms);
    }

    export const getEventsAfterTimestamp = (timestamp: number) =>
    {
        const result: BaseEventInfo[] = [];
        for (const e of cachedEvents) {
            if (timestamp > e.timestamp) break;
            result.push(e);
        }
        return result;
    }
}
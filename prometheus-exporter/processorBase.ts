import axios, { AxiosResponse } from 'axios';

function formatDuration(seconds: number): string {
    if (seconds < 0) {
        return `${formatDuration(-seconds)} ago`;
    }

    const days = Math.floor(seconds / (24 * 60 * 60));
    const hours = Math.floor((seconds % (24 * 60 * 60)) / (60 * 60));
    const minutes = Math.floor((seconds % (60 * 60)) / 60);

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);

    return parts.join(' ') || 'less than a minute';
}

class ProcessorBase {
    protected readonly subgraphUrl: string;
    public readonly networkName: string;
    protected readonly MAX_ITEMS = 1000;

    constructor(subgraphUrl: string, networkName: string) {
        this.subgraphUrl = subgraphUrl;
        this.networkName = networkName;
    }

    protected async _graphql(query: string): Promise<AxiosResponse> {
        const response = await axios.post(this.subgraphUrl, { query });
        if (response.data.errors) {
            console.error('GraphQL errors:', JSON.stringify(response.data.errors, null, 2));
            throw new Error('GraphQL query returned errors');
        }
        return response;
    }

    protected async _queryAllPages(queryFn: (lastId: string) => string, toItems: (res: AxiosResponse<any>) => any[], itemFn: (item: any) => any): Promise<any[]> {
        let lastId = "";
        const items: any[] = [];

        while (true) {
            const res = await this._graphql(queryFn(lastId));

            if (res.status !== 200) {
                console.error(`Bad HTTP status: ${res.status}`);
                throw new Error(`HTTP request failed with status ${res.status}`);
            } else if (res.data.errors) {
                console.error('GraphQL errors:', JSON.stringify(res.data.errors, null, 2));
                throw new Error('GraphQL query returned errors');
            } else if (!res.data.data) {
                console.error("Empty response data");
                throw new Error("Empty response data from GraphQL query");
            } else {
                const newItems = toItems(res);
                items.push(...newItems.map(itemFn));

                if (newItems.length < this.MAX_ITEMS) {
                    break;
                } else {
                    lastId = newItems[newItems.length - 1].id;
                }
            }
        }

        return items;
    }
}

export { ProcessorBase, formatDuration }; 
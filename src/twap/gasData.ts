
import { Client } from "pg";
import { formatUnits } from "ethers";
    
interface RawBlockData {
  block_number?: number;
  base_fee_per_gas?: string;
  timestamp: number;
}

export interface FormattedBlockData {
  blockNumber: number | undefined;
  timestamp: number;
  basefee: number | undefined;

}

export interface GasData {
  blockNumber: number;
  timestamp: number;
  basefee: number;
}


export class GasDataService {

  
  async getGasData(
    {bucketCount, fromTs, toTs}: {bucketCount: number, fromTs: number, toTs: number}
  ): Promise<RawBlockData[]> {
    const client = new Client({
      connectionString: process.env.DATABASE_URL,
    });
    await client.connect();
    const query = `
        WITH selected_blocks AS (
          SELECT DISTINCT ON (bucket) number, base_fee_per_gas, timestamp
          FROM (
            SELECT number, base_fee_per_gas, timestamp,
                  NTILE($1) OVER (ORDER BY timestamp ASC) AS bucket
            FROM blockheaders
            WHERE timestamp BETWEEN $2 AND $3
          ) AS sub
          ORDER BY bucket, timestamp DESC
        )
        SELECT number AS block_number, base_fee_per_gas, timestamp
        FROM selected_blocks
        ORDER BY timestamp ASC;
      `;
    const values = [bucketCount, fromTs, toTs];
    const result = await client.query(query, values);
    await client.end();
    return result.rows.map((r: any) => ({
      block_number: r.block_number || undefined,
      base_fee_per_gas: r.base_fee_per_gas || undefined,
      timestamp: Number(r.timestamp),
    }));
  }
  async formatGasData(rawData: RawBlockData[]): Promise<FormattedBlockData[]> {
    let sortedData = rawData.sort((a, b) => a.timestamp - b.timestamp);

    // Convert base_fee_per_gas to gwei
    const formattedData: FormattedBlockData[] = sortedData.map((r) => ({
      blockNumber: r.block_number ? r.block_number : 0,
      timestamp: r.timestamp ? r.timestamp : 0,
      basefee: r.base_fee_per_gas
        ? Number(formatUnits(parseInt(r.base_fee_per_gas), "gwei"))
        : 0,
    }));
    return formattedData;
  }
}

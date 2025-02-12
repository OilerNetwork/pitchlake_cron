import { fetchBlockTWAPData } from "./db";
import { FormattedBlockData } from "./gasData";
import { Pool } from "pg";
export const getTWAPs = (
  latestBlock:FormattedBlockData,
  blockData: FormattedBlockData[],
  firstTimestamp: number,
  twapRanges: number[],
  pool: Pool
): FormattedBlockData[] => {
  // Early return for invalid inputs
  if (!blockData?.length) {
    return [];
  }



  const blockDataWithTWAP = blockData.map(b => {
    const prevTwap = fetchBlockTWAPData(pool, b.blockNumber - 1);
    return {
      ...b,
      prevTwap: prevTwap,
    }
  })

    // Pre-filter blocks before processing to reduce iterations
    const relevantBlocks = blockData.filter(b => b.timestamp >= firstTimestamp);
    if (!relevantBlocks.length) return [];

  const dataWithTWAP = relevantBlocks.map((currentBlock, currentIndex) => {
    const currentTime = currentBlock.timestamp;
    const windowStart = currentTime - twapRange;

    // Find the last known fee using binary search for better performance
    let lastKnownFee: number | undefined;
    let left = 0;
    let right = currentIndex;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const block = blockData[mid];
      
      if (block.basefee !== undefined) {
        if (block.timestamp <= windowStart) {
          lastKnownFee = block.basefee;
          left = mid + 1;
        } else {
          right = mid - 1;
        }
      } else {
        right = mid - 1;
      }
    }

    // If no fee found before window, get the first available fee
    if (lastKnownFee === undefined) {
      const firstFeeBlock = blockData.find(b => b.basefee !== undefined);
      if (!firstFeeBlock?.basefee) return currentBlock;
      lastKnownFee = firstFeeBlock.basefee;
    }

    // Build segments more efficiently
    const segments: { start: number; fee: number }[] = [];
    let prevTs = windowStart;
    let prevFee = lastKnownFee;

    // Only look at blocks within our window
    const windowBlocks = blockData.slice(0, currentIndex + 1)
      .filter(b => b.basefee !== undefined && 
               b.timestamp >= windowStart && 
               b.timestamp <= currentTime);

    for (const block of windowBlocks) {
      if (block.timestamp > prevTs) {
        segments.push({ start: prevTs, fee: prevFee });
      }
      prevTs = block.timestamp;
      prevFee = block.basefee!;
    }

    if (currentTime > prevTs) {
      segments.push({ start: prevTs, fee: prevFee });
    }

    // Calculate TWAP
    let weightedSum = 0;
    let totalSeconds = 0;

    segments.forEach((segment, i) => {
      const endSegment = i < segments.length - 1 ? segments[i + 1].start : currentTime;
      const delta = endSegment - segment.start;
      
      if (delta > 0) {
        weightedSum += segment.fee * delta;
        totalSeconds += delta;
      }
    });

    const twap = totalSeconds === 0 ? prevFee : weightedSum / totalSeconds;

    // Return appropriate block format
    if (currentBlock.isUnconfirmed) {
      return {
        ...currentBlock,
        unconfirmedTwap: twap,
        unconfirmedBasefee: currentBlock.basefee,
      };
    } else if (currentBlock.basefee !== undefined) {
      return {
        ...currentBlock,
        confirmedTwap: twap,
        confirmedBasefee: currentBlock.basefee,
      };
    }
    
    return currentBlock;
  });

  return dataWithTWAP;
};
  
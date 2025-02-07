import { 
    Contract, 
    RpcProvider, 
    Account,
    CairoCustomEnum,
} from "starknet";
import { Logger } from "winston";
import { setupLogger } from "./logger";
import { ABI as VaultAbi } from "./abi/vault";
import { ABI as OptionRoundAbi } from "./abi/optionRound";
import axios from "axios";

// Enum matching the Cairo OptionRoundState
enum OptionRoundState {
    Open = 0,
    Auctioning = 1, 
    Running = 2,
    Settled = 3
}

export class StateTransitionService {
    private logger: Logger;
    private provider: RpcProvider;
    private account: Account;
    private vaultContract: Contract;
    private fossilApiKey: string;
    private fossilApiUrl: string;

    constructor(
        rpcUrl: string,
        privateKey: string,
        accountAddress: string,
        vaultAddress: string,
        fossilApiKey: string,
        fossilApiUrl: string
    ) {
        this.logger = setupLogger();
        this.provider = new RpcProvider({ nodeUrl: rpcUrl });
        this.account = new Account(
            this.provider,
            accountAddress,
            privateKey
        );
        this.vaultContract = new Contract(
            VaultAbi,
            vaultAddress,
            this.account
        );
        this.fossilApiKey = fossilApiKey;
        this.fossilApiUrl = fossilApiUrl;
    }

    async checkAndTransition(): Promise<void> {
        try {
            // Test connection before proceeding
            this.logger.info(`Checking RPC connection...`);
            await this.provider.getChainId();
            this.logger.info(`Connected to RPC successfully`);
            
            const roundId = await this.vaultContract.get_current_round_id();
            const roundAddress = await this.vaultContract.get_round_address(roundId);

            // Convert decimal address to hex
            const roundAddressHex = "0x" + BigInt(roundAddress).toString(16);
            this.logger.info(`Checking round ${roundId} at ${roundAddressHex}`);

            const roundContract = new Contract(
                OptionRoundAbi,
                roundAddressHex,
                this.account
            );
            
            const stateRaw = await roundContract.get_state();
            const state = (stateRaw as CairoCustomEnum).activeVariant();

            const stateEnum = OptionRoundState[state as keyof typeof OptionRoundState];
            this.logger.info(`Current state: ${state}`);

            const currentTime = Math.floor(Date.now() / 1000);

            switch (stateEnum) {
                case OptionRoundState.Open:
                    await this.handleOpenState(roundContract, currentTime);
                    break;
                    
                case OptionRoundState.Auctioning:
                    await this.handleAuctioningState(roundContract, currentTime);
                    break;
                    
                case OptionRoundState.Running:
                    await this.handleRunningState(roundContract, currentTime);
                    break;
                    
                case OptionRoundState.Settled:
                    this.logger.info("Round is settled - no actions possible");
                    break;
            }
        } catch (error) {
            this.logger.error("Error in transition check:", error);
            throw error;
        }
    }

    private async handleOpenState(roundContract: Contract, currentTime: number): Promise<void> {
        try {
            const auctionStartTime = await roundContract.get_auction_start_date();
            
            if (currentTime >= auctionStartTime) {
                this.logger.info("Starting auction...");
                
                const { transaction_hash } = await this.vaultContract.start_auction();
                await this.provider.waitForTransaction(transaction_hash);
                
                this.logger.info("Auction started successfully", {
                    transactionHash: transaction_hash
                });
            } else {
                this.logger.info(`Waiting for auction start time. Current: ${currentTime}, Start: ${auctionStartTime}`);
            }
        } catch (error) {
            this.logger.error("Error handling Open state:", error);
            throw error;
        }
    }

    private async handleAuctioningState(roundContract: Contract, currentTime: number): Promise<void> {
        try {
            const auctionEndTime = await roundContract.get_auction_end_date();
            
            if (currentTime >= auctionEndTime) {
                this.logger.info("Ending auction...");
            
                const { transaction_hash } = await this.vaultContract.end_auction();
                await this.provider.waitForTransaction(transaction_hash);
                
                this.logger.info("Auction ended successfully", {
                    transactionHash: transaction_hash
                });
            } else {
                this.logger.info(`Waiting for auction end time. Current: ${currentTime}, End: ${auctionEndTime}`);
            }
        } catch (error) {
            this.logger.error("Error handling Auctioning state:", error);
            throw error;
        }
    }

    private async handleRunningState(roundContract: Contract, currentTime: number): Promise<void> {
        try {
            const settlementTime = await roundContract.get_option_settlement_date();
            
            if (currentTime >= settlementTime) {
                this.logger.info("Settlement time reached, preparing Fossil request...");
                
                const requestData = await this.vaultContract.get_request_to_settle_round();
                this.logger.info("Request data received:", requestData);
                
                // Format request for Fossil API
                const vaultAddress = "0x" + requestData[0].toString(16);
                const timestamp = Number(requestData[1]);
                const identifier = "0x" + requestData[2].toString(16);

                const clientAddressRaw = await this.vaultContract.get_fossil_client_address();
                const clientAddress = "0x" + clientAddressRaw.toString(16);

                this.logger.info("Parsed timestamp:", timestamp);

                const ONE_MONTH_SECONDS = 2592000;
                const ONE_WEEK_SECONDS = 604800;

                const fossilRequest = {
                    identifiers: [identifier],
                    params: {
                        twap: [timestamp - ONE_WEEK_SECONDS, timestamp],
                        volatility: [timestamp - ONE_WEEK_SECONDS, timestamp],
                        reserve_price: [timestamp - ONE_MONTH_SECONDS, timestamp]
                    },
                    client_info: {
                        client_address: clientAddress,
                        vault_address: vaultAddress,
                        timestamp
                    }
                };

                this.logger.info("Sending request to Fossil API", { request: fossilRequest });

                const response = await axios.post(
                    `${this.fossilApiUrl}/pricing_data`,
                    fossilRequest,
                    {
                        headers: {
                            "Content-Type": "application/json",
                            "x-api-key": this.fossilApiKey
                        }
                    }
                );

                const jobId = response.data.job_id;
                this.logger.info("Fossil request submitted", { 
                    jobId,
                    response: response.data 
                });
            } else {
                this.logger.info(`Waiting for settlement time. Current: ${currentTime}, Settlement: ${settlementTime}`);
            }
        } catch (error) {
            this.logger.error("Error handling Running state:", error);
            throw error;
        }
    }
} 
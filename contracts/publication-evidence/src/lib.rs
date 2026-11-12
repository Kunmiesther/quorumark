use near_sdk::{env, near, AccountId, PanicOnDefault};
use near_sdk::collections::LookupMap;

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Publication {
    pub commitment: String,
    pub strategy_id: String,
    pub version_id: String,
    pub creator: AccountId,
    pub recorded_at_ns: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct PublicationEvidence {
    owner_id: AccountId,
    publications: LookupMap<String, Publication>,
}

#[near]
impl PublicationEvidence {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        assert!(!env::state_exists(), "Contract is already initialized");
        Self { owner_id, publications: LookupMap::new(b"p") }
    }

    pub fn record_publication(&mut self, commitment: String, strategy_id: String, version_id: String) {
        assert_eq!(env::predecessor_account_id(), env::signer_account_id(), "Proxy calls are not allowed");
        assert_eq!(env::predecessor_account_id(), self.owner_id, "Only the contract owner may publish evidence");
        assert_eq!(commitment.len(), 64, "Commitment must be a SHA-256 hex digest");
        assert!(commitment.bytes().all(|byte| byte.is_ascii_hexdigit()), "Commitment must be hexadecimal");
        assert!(!strategy_id.is_empty() && strategy_id.len() <= 128, "Invalid strategy identifier");
        assert!(!version_id.is_empty() && version_id.len() <= 128, "Invalid version identifier");
        let key = format!("{}:{}", strategy_id, version_id);
        if let Some(existing) = self.publications.get(&key) {
            assert_eq!(existing.commitment, commitment, "Publication commitment cannot change");
            return;
        }
        self.publications.insert(&key, &Publication {
            commitment,
            strategy_id,
            version_id,
            creator: env::signer_account_id(),
            recorded_at_ns: env::block_timestamp(),
        });
    }

    pub fn get_publication(&self, strategy_id: String, version_id: String) -> Option<Publication> {
        self.publications.get(&format!("{}:{}", strategy_id, version_id))
    }

    pub fn owner_id(&self) -> AccountId { self.owner_id.clone() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::{testing_env, test_utils::VMContextBuilder, AccountId};

    fn context(account: &str) {
        testing_env!(VMContextBuilder::new()
            .signer_account_id(account.parse::<AccountId>().unwrap())
            .predecessor_account_id(account.parse::<AccountId>().unwrap())
            .build());
    }

    #[test]
    fn initialized_contract_records_and_replays_same_publication() {
        context("estarkunmi.testnet");
        let mut contract = PublicationEvidence::new("estarkunmi.testnet".parse().unwrap());
        assert_eq!(contract.owner_id().as_str(), "estarkunmi.testnet");

        contract.record_publication("a".repeat(64), "strategy".to_string(), "version".to_string());
        contract.record_publication("a".repeat(64), "strategy".to_string(), "version".to_string());

        let publication = contract.get_publication("strategy".to_string(), "version".to_string()).unwrap();
        assert_eq!(publication.creator.as_str(), "estarkunmi.testnet");
        assert_eq!(publication.commitment, "a".repeat(64));
    }

    #[test]
    #[should_panic(expected = "Only the contract owner may publish evidence")]
    fn unauthorized_publication_is_rejected() {
        context("attacker.testnet");
        let mut contract = PublicationEvidence::new("estarkunmi.testnet".parse().unwrap());
        contract.record_publication("a".repeat(64), "strategy".to_string(), "version".to_string());
    }

    #[test]
    #[should_panic(expected = "Publication commitment cannot change")]
    fn publication_commitment_cannot_change() {
        context("estarkunmi.testnet");
        let mut contract = PublicationEvidence::new("estarkunmi.testnet".parse().unwrap());
        contract.record_publication("a".repeat(64), "strategy".to_string(), "version".to_string());
        contract.record_publication("b".repeat(64), "strategy".to_string(), "version".to_string());
    }

    #[test]
    fn publication_retrieval_preserves_strategy_version_and_commitment() {
        context("estarkunmi.testnet");
        let mut contract = PublicationEvidence::new("estarkunmi.testnet".parse().unwrap());
        contract.record_publication(
            "197d61c8cdddc46d637de611807457c021fb11e95c3895366c98f3b69a4b0786".to_string(),
            "64a8efa3-42ee-4158-8f59-bb891b921a55".to_string(),
            "cf3a328c-2d87-418f-830d-9e827f04c1f1".to_string(),
        );
        let publication = contract
            .get_publication(
                "64a8efa3-42ee-4158-8f59-bb891b921a55".to_string(),
                "cf3a328c-2d87-418f-830d-9e827f04c1f1".to_string(),
            )
            .expect("publication should exist");
        assert_eq!(publication.commitment, "197d61c8cdddc46d637de611807457c021fb11e95c3895366c98f3b69a4b0786");
        assert_eq!(publication.creator.as_str(), "estarkunmi.testnet");
    }
}

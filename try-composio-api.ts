// Try to find the correct API endpoint by looking at the SDK source
import { readFileSync } from "fs";
import { execSync } from "child_process";

// Find the API key related code in the SDK
const result = execSync('grep -r "api.key\\|apiKey\\|api_key\\|createApiKey\\|generateKey" node_modules/@composio/core/dist/ --include="*.mjs" -l 2>/dev/null | head -5').toString();
console.log("Files with apiKey:", result);

// Search for the actual endpoint
const endpoint = execSync('grep -r "api.key\\|/keys\\|/api-key" node_modules/@composio/core/dist/ --include="*.mjs" 2>/dev/null | grep "post\\|POST\\|create" | head -10').toString();
console.log("Endpoint references:", endpoint);

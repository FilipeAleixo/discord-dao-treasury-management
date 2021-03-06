import { APIGatewayEvent, APIGatewayProxyResult } from 'aws-lambda'
import { Lambda } from 'aws-sdk';
import apiResponses from 'src/requests/apiResponses'
import { authenticate, getAuthenticationChallenge } from '../lib/auth'
import * as jwt from 'jsonwebtoken';
import axios from 'axios';
import { utils } from 'ethers' //providers, Wallet } from 'ethers'
//import { VaultLib } from '@enzymefinance/protocol';
import { updateEnzymeAuthenticated } from '../models/authentication'


/**
 * GET /sessions
 *
 * Returns a nonce given a public address
 * @method nonce
 * @param {String} event.queryStringParameter['PublicAddress']
 * @throws Returns 401 if the user is not found
 * @returns {Object} nonce for the user to sign
 */
export async function nonce(
  event: APIGatewayEvent
): Promise<APIGatewayProxyResult> {
  const parameters = event.queryStringParameters

  console.log(parameters)

  const publicAddress = parameters['PublicAddress']
  const userIdToken = parameters['userIdToken']

  const decoded = jwt.verify(userIdToken, process.env.JWT_SECRET);
  const discordUserID = decoded.userId;

  try {
    const nonce = await getAuthenticationChallenge(publicAddress, discordUserID)
    return apiResponses._200({ nonce })
  } catch (e) {
    return apiResponses._400({ error: e.message })
  }
}

/**
 * POST /sessions
 *
 * Returns a JWT, given a username and password.
 * @method login
 * @param {String} event.body.username
 * @param {String} event.body.signature
 * @throws Returns 401 if the user is not found or signature is invalid.
 * @returns {Object} jwt that expires in 5 mins
 */
export async function login(
  event: APIGatewayEvent
): Promise<APIGatewayProxyResult> {

  /*
  const provider = new providers.JsonRpcProvider(
    process.env.ETHEREUM_NODE_ENDPOINT,
    'kovan'
  );
  // We don't need a specific wallet here, since we just want to get the address of the vault's manager
  const wallet = Wallet.createRandom().connect(provider);
  const vault = new VaultLib(process.env.VAULT_ADDRESS, wallet);
  */

  const invokeRoleAssignLambda = async (discordUserID, publicAddress, roles) => {
    const lambda = new Lambda({region: "us-east-2"});
    return new Promise((resolve, reject) => {
      const params = {
        FunctionName: "discord-role-assign",
        Payload: JSON.stringify({ discordUserID, publicAddress, roles })
      }
      lambda.invoke(params, (err, results) => {
        if(err) reject(err);
        else resolve(results.Payload);
      })
    })
  }

  const getNumberOfShares = async (investorAddress, vaultAddress) => {
    const url = process.env.ENZYME_API_ENDPOINT + 
    '/vault-info?field=shares-balance&vaultAddress=' + vaultAddress +
    '&investorAddress=' + investorAddress;

    try {
      const response = await axios.get(url)
      if (response) {
        if (response.data.balance) {
          return parseFloat(response.data.balance);
        }
        else return "-1"
      }
      else return "-1";
    }
    catch {
      return "-1"
    }
  }

  const isVaultOwner = async (address, vaultAddress) => {
    const url = process.env.ENZYME_API_ENDPOINT + 
    '/vault-info?field=owner&vaultAddress=' + vaultAddress;

    try {
      const response = await axios.get(url)
      if (response) {
        if (response.data.address) {
          return response.data.address.toLowerCase() === address.toLowerCase();
        }
        else return "-1"
      }
      else return "-1";
    }
    catch {
      return "-1"
    }
  }

  try {
    const eventData = JSON.parse(event.body)

    const 
      publicAddress : string = eventData.publicAddress,
      signature : string = eventData.signature,
      userIdToken : string = eventData.userIdToken;

    // If no error was thrown, let's decode the JWT the user gave us (the one they received from Discord)
    // and get the respective Discord user ID and Enzyme vault address
    const decoded = jwt.verify(userIdToken, process.env.JWT_SECRET);
    const discordUserID = decoded.userId;
    const discordUsername = decoded.username;

    const token = await authenticate(publicAddress, signature, discordUserID)

    // The number of shares that the user owns from this vault
    const [ shares, isOwner ] = await Promise.all([
      getNumberOfShares(publicAddress, decoded.vaultAddress),
      isVaultOwner(publicAddress, decoded.vaultAddress)
    ]);

    // If one of them returned -1, don't allow authentication bc something went wrong
    const status = shares !== "-1" && isOwner !== "-1";

    if (status) {
      console.log(`Address: ${publicAddress}\nShares: ${shares}\nOwner: ${isOwner}`)
      // If the user doesn't own any shares nor is the owner of the vault, do nothing
      if (shares == 0 && !isOwner) {
        return apiResponses._400({ error: "For authentication, the address must own shares from the vault and/or be the vault's owner" })
      }
      else {
        // Doing it always in one single call to make execution time faster
        if(shares > 0 && isOwner) {
          // Attribute both investor and owner
          await invokeRoleAssignLambda(
            discordUserID,
            publicAddress,
            [process.env.DISCORD_INVESTOR_ROLE_ID, process.env.DISCORD_OWNER_ROLE_ID]
          );
        }
        else if (shares > 0) {
          // Attribute only investor role
          await invokeRoleAssignLambda(
            discordUserID,
            publicAddress,
            [process.env.DISCORD_INVESTOR_ROLE_ID]
          );
        }
        else if (isOwner) {
          // Attribute only owner role
          await invokeRoleAssignLambda(
            discordUserID,
            publicAddress,
            [process.env.DISCORD_OWNER_ROLE_ID]
          );
        }
        // Doing this just to enforce that it's a boolean. Truth be told `getNumberOfShares` and `isVaultOwner` should be refactored
        // to return consistent types, but I'm running short on time.
        const owner = !!isOwner;
        // TODO Possible to parallelize this with the calls to avoid wasting time
        await updateEnzymeAuthenticated({ publicAddress, discordUserID, discordUsername, owner, shares });
        return apiResponses._200({ shares: shares, owner: isOwner })
      }
    }
    else {
      return apiResponses._400({ error: "There's been an error." })
    }
  } catch (e) {
    console.log(`Error: ${e.message}`)
    return apiResponses._400({ error: e.message })
  }
}

/**
 * OPTION /{proxy+}
 *
 * Returns proper CORS config
 */
export function defaultCORS(event: APIGatewayEvent): APIGatewayProxyResult {
  const response = {
    // Success response
    statusCode: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify({}),
  }
  return response
}

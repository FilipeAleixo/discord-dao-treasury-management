const { Lambda, EventBridge } = require("aws-sdk");
const axios = require("axios");
const { v1: uuidv1 } = require("uuid");
const { Client: DiscordClient, MessageEmbed } = require("discord.js");
require("discord-reply"); // Enables replies with decorator (only available on discord.js v13)
const { getDiscordUserPublicAddress } = require("./models/authentication");

const eventBridge = new EventBridge();
const lambda = new Lambda();
const client = new DiscordClient();

const ETHERSCAN_TX_URL = "https://kovan.etherscan.io/tx/";

// Note: I'm using Discord.js v12.5.3 because v13 is only compatible with node 16.
// Lambda currently only allows for node 14.

client.login(process.env.DISCORD_BOT_TOKEN);

const waitForClient = () => {
  return new Promise((resolve, reject) => {
    // client.isReady is not available in v12.5.3, so I used uptime
    if (client.uptime == null) {
      client.on("ready", () => {
        resolve();
      });
    }
    // If uptime != null, client is ready - resolve immediately
    else {
      resolve();
    }
  });
};

exports.startPoll = async function (event, context) {
  await waitForClient();

  const pollExpirationDate = getPollExpirationDate(event.pollParams.duration);
  // Create poll and add the vote reactions
  const embed = getStartPollEmbed(event.pollParams, pollExpirationDate);
  const message = await client.channels.cache.get(event.channelID).send(embed);
  await addPollVoteReactions(message, event.pollParams);

  // Schedule the votes counting and subsequent eventbridge clean-up
  await scheduleResultsCounting(
    message.id,
    event.channelID,
    event.pollParams,
    pollExpirationDate
  );

  return true;
};

function getStartPollEmbed(pollParams, pollExpirationDate) {
  // https://discord.js.org/#/docs/main/master/class/MessageEmbed
  const embed = new MessageEmbed()
    // Set the title of the field
    .setTitle("DAO Treasury Poll")
    // Set the color of the embed
    .setColor(0xff0000)
    // Set the main content of the embed
    .setDescription("Yes/No vote for the following trade parameters.")
    .addFields(
      {
        name: "Poll Duration:",
        value: `${pollParams.duration} minutes`,
      },
      {
        name: "Ticker of the token to sell:",
        value: pollParams["token-sell-ticker"],
      },
      {
        name: "Amount of the token to sell:",
        value: pollParams["token-sell-amount"],
      },
      {
        name: "Ticker of the token to buy:",
        value: pollParams["token-buy-ticker"],
      },
      { name: "\u200B", value: "\u200B" }, // Empty space
      { name: "Vote Yes", value: "👍", inline: true },
      { name: "Vote No", value: "👎", inline: true },
      { name: "\u200B", value: "\u200B" },
    )
    .setFooter(`Expires ${pollExpirationDate}`);
  return embed
}

async function addPollVoteReactions(message, pollParams) {
  if (pollParams.pollType === "yes-no") {
    await message.react("👍");
    await message.react("👎");
  }
  else if (pollParams.pollType === "choose-token") {
  }
  return true
}

exports.resolvePoll = async function (event, context) {
  await waitForClient();

  // DEBUG
  //console.log(`CONTEXT ${JSON.stringify(context)}`);
  //console.log(`EVENT ${JSON.stringify(event)}`);
  // DEBUG

  const message = await client.channels.cache
    .get(event.channelID)
    .messages.fetch(event.messageID);

  const userReactions = await getUsersThatReactedWith(message, ["👍", "👎"]);
  console.log(JSON.stringify(userReactions));
  const { winnerEmoji, reactionScores } = await getReactionScores(userReactions);
  console.log(JSON.stringify(reactionScores));
  await message.lineReplyNoMention(JSON.stringify(reactionScores));

  // Now, the way we will act upon the results will depend on the poll type:
  if (event.pollParams.pollType == "yes-no") {
    // If we had a score for 👍 higher than 50, proceed with the trade
    if (reactionScores["👍"].normalizedScore > 50.0) {
      try {
        const tradeDetails = await executeEnzymeTrade({
          "token-buy-ticker": event.pollParams["token-buy-ticker"],
          "token-sell-ticker": event.pollParams["token-sell-ticker"],
          "token-sell-amount": event.pollParams["token-sell-amount"],
        });
        console.log(`TRADE STATUS: ${JSON.stringify(tradeDetails, null, 2)}`);
        const embed = getResolvePollEmbed(
          event.pollParams,
          { pollOutcome: true, transactionOutcome: tradeDetails },
          reactionScores
        );
        await message.lineReplyNoMention(embed);
      } catch (e) {
        await message.lineReplyNoMention(`Error: ${e.message}`);
      }
    }
    // Else do nothing
    else {
      const embed = getResolvePollEmbed(
        event.pollParams,
        { pollOutcome: false },
        reactionScores
      );
      await message.lineReplyNoMention(embed);
    }

  } else if (event.pollParams.pollType == "choose-token") {
  }

  // Clean up
  await Promise.all([
    // Remove the permission for event bridge to call this lambda
    lambda
      .removePermission({
        FunctionName: context.functionName,
        StatementId: event.eventBridgeRuleName,
      })
      .promise(),
    // Delete the event bridge rule to call the lambda
    deleteEventBridgeRule(event.eventBridgeRuleName),
  ]);
  return true;
};

function executeEnzymeTrade(tradeParams) {
  return new Promise((resolve, reject) => {
    const params = {
      FunctionName: process.env.ENZYME_EXECUTE_TRADE_FUNCTION_ARN,
      Payload: JSON.stringify(tradeParams),
    };
    lambda.invoke(params, (err, results) => {
      if (err) reject(err);
      else resolve(JSON.parse(results.Payload));
    });
  });
}

function getResolvePollEmbed(pollParams, outcome, voteDetails) {
  console.log("HEREE")
  console.log(JSON.stringify(outcome, null, 2))
  // https://discord.js.org/#/docs/main/master/class/MessageEmbed
  const embed = new MessageEmbed()
    // Set the title of the field
    .setTitle("DAO Treasury Poll Results")
    // Set the color of the embed
    .setColor(0x0000ff)
    // Set the main content of the embed
  if (pollParams.pollType == "yes-no") {
    embed.setDescription("Yes/No vote").addFields(
      {
        name: "Parameters:",
        value: `Trade ${pollParams["token-sell-amount"]} ${pollParams["token-sell-ticker"]} for ${pollParams["token-buy-ticker"]}.`,
      },
      {
        name: "Outcome:",
        value: outcome.pollOutcome ? "Execute trade." : "Don't execute trade.",
      }
    );
    // If poll result was yes
    if (outcome.pollOutcome) {
      // If the lambda that executed the trade returned 200 status code
      if (outcome.transactionOutcome.statusCode == 200) {
        embed.addFields({
          name: "Transaction Succeeded. TX Hash:",
          value: `${
            outcome.transactionOutcome.body.txHash
          } [View on Etherscan](${
            ETHERSCAN_TX_URL + outcome.transactionOutcome.body.txHash
          })`,
        });
      }
      else {
        embed.addFields({
          name: "Transaction Failed. Reason:",
          value: outcome.transactionOutcome.body.message,
        });
      }
    }
    embed.addFields(
      { name: "\u200B", value: "\u200B" }, // Empty space
      {
        name: "Full vote details:",
        value: JSON.stringify(voteDetails, null, 2),
      }
    );
  }
  return embed;
}

// Schedule the Lambda function that will count the poll results
async function scheduleResultsCounting(
  messageID,
  channelID,
  pollParams,
  scheduleDate
) {
  const ruleName = `poll-results-rule-${uuidv1()}`;
  const cronExpression = getScheduleCron(scheduleDate);
  // Create EventBridge rule
  // This will use the default event bus
  const rule = await eventBridge
    .putRule({
      Name: ruleName,
      ScheduleExpression: cronExpression,
    })
    .promise();

  // Save time by doing the two requests at once
  await Promise.all([
    // Grant permission to this EventBridge rule to call the Lambda that counts the votes
    lambda
      .addPermission({
        Action: "lambda:InvokeFunction",
        FunctionName: process.env.DISCORD_POLL_RESOLVE_FUNCTION_ARN,
        Principal: "events.amazonaws.com",
        StatementId: ruleName,
        SourceArn: rule.RuleArn,
      })
      .promise(),

    // Put the lambda in the targets of the EventBridge rule
    eventBridge
      .putTargets({
        Rule: ruleName,
        Targets: [
          {
            Id: `${ruleName}-target`,
            Arn: process.env.DISCORD_POLL_RESOLVE_FUNCTION_ARN,
            Input: JSON.stringify({
              eventBridgeRuleName: ruleName,
              messageID,
              channelID,
              pollParams,
            }),
          },
        ],
      })
      .promise(),
  ]);

  return true;
}

function getPollExpirationDate(minutes) {
  var currentDate = new Date();
  var expirationDate = new Date();
  expirationDate.setTime(currentDate.getTime() + minutes * 60 * 1000);
  return expirationDate
}

// Get the corresponding cron expression for N minutes from now
// Cron format for AWS here:
// https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-create-rule-schedule.html
function getScheduleCron (scheduleDate) {
    // EventBridge doesn't provide second-level precision in schedule expressions.
    // The finest resolution using a cron expression is one minute. 
    const cronMinutes = scheduleDate.getMinutes(),
      cronHours = scheduleDate.getHours(),
      cronDayOfMonth = scheduleDate.getDate(),
      cronMonth = scheduleDate.getMonth() + 1, // cron is 1-12 for months
      cronDayOfWeek = "?", // cron code for any
      cronYear = scheduleDate.getFullYear();
        
    const cronExpression =
      `cron(` +
      `${cronMinutes} ` +
      `${cronHours} ` +
      `${cronDayOfMonth} ` +
      `${cronMonth} ` +
      `${cronDayOfWeek} ` +
      `${cronYear}` +
      `)`;
    
    return cronExpression
}

async function deleteEventBridgeRule(ruleName) {
  // Delete all the target from the rule
  await eventBridge
    .removeTargets({
      Ids: [`${ruleName}-target`],
      Rule: ruleName,
      Force: true, // just in case, not sure if required here
    })
    .promise();
  // Delete the rule
  await eventBridge
    .deleteRule({
      Name: ruleName,
      Force: true,
    })
    .promise();

  return true
}

// Given all the addresses that a certain discord user ID has registered in the database,
// get the one that the user authenticated most recently
function getLatestAddress(addresses) {
  var maxDate = new Date(0);
  var latestAddressIndex = 0;

  addresses.map(function (obj, index) {
    updatedDate = new Date(obj.UpdatedAt);
    if (updatedDate > maxDate) {
      maxDate = updatedDate;
      latestAddressIndex = index;
    }
  });
  return addresses[latestAddressIndex].PublicAddress;
}

// Get array of objects with reactions to a specific message
// Each object has an emoji identifier and a list of users that reacted with that emoji
async function getUsersThatReactedWith(message, emojis) {
  // Loop through all the emojis and return an array of objects where each one has
  // the respective emoji and a promise with the users
  const allReactionsPromises = emojis.map(async (emoji) => {
    return {
      emoji: emoji,
      // Note: the maximum number of users to fetch like this is 100. Didn't look further on how to
      // get an unlimited number of users
      // https://discord.js.org/#/docs/main/12.5.3/class/ReactionUserManager?scrollTo=fetch
      users: await message.reactions.resolve(emoji).users.fetch({ limit: 100 }),
    };
  });

  // return promise that will resolve once the fetching of all the users for the different emojis has finished
  return Promise.all(allReactionsPromises);
}

async function getSharesFromDiscordUserID(discordUserID) {
  // 1. Get all the authenticated addresses from the user
  const publicAddresses = await getDiscordUserPublicAddress(discordUserID);
  //console.log(`---->>>> HERE USER: ${discordUserID}`);
  //console.log(publicAddresses);

  if (publicAddresses.Count > 0) {
    // 2. Get the latest address
    const publicAddress = getLatestAddress(publicAddresses.Items);
    //console.log(`LATEST ADDRESS: ${publicAddress}`);
    // 3. Call the enzyme API to get the balance of that address
    const url =
      process.env.ENZYME_API_ENDPOINT +
      "/vault-info?field=shares-balance&vaultAddress=" +
      process.env.VAULT_ADDRESS +
      "&investorAddress=" +
      publicAddress;
    //console.log(url);

    try {
      const response = await axios.get(url);
      if (response) {
        if (response.data.balance) {
          return parseFloat(response.data.balance);
        } else return 0;
      } else return 0;
    } catch (e) {
      return 0;
    }
  }
  // If the user voted but doesn't have any authenticated addresses, return that they own 0 shares
  else return 0;
}

// Loop through all the reaction emojis, fetch the number of shares that each user has and calculate a score
// for each reaction
async function getReactionScores(userReactions) {
  // We have a nested map, and since Promise.all is not recursive, we need
  // to also enclose the outer map in a Promise.all
  //https://stackoverflow.com/questions/69457404/how-to-await-promise-function-inside-nested-maps/69457482#69457482
  const reactionsWithSharesArr = await Promise.all(
    userReactions.map(async (reactions) => {
      return {
        [reactions.emoji]: {
          shares: await Promise.all(
            reactions.users
              .filter((user) => {
                // Don't consider the initial bot votes
                return user.username !== "dao-treasury-management";
              })
              .map(async (user) => {
                return {
                  username: user.username,
                  // Just as an example of something to wait for
                  shares: await getSharesFromDiscordUserID(user.id),
                };
              })
          ),
        }
      };
    })
  );
  
  console.log(JSON.stringify(reactionsWithSharesArr, null, 2));

  // Merge the array of objects into a single object
  var reactionsWithShares = reactionsWithSharesArr.reduce(function (
    result,
    currentObject
  ) {
    for (var key in currentObject) {
      if (currentObject.hasOwnProperty(key)) {
        result[key] = currentObject[key];
      }
    }
    return result;
  },
  {});

  console.log(JSON.stringify(reactionsWithShares, null, 2));

  // Count the share scores
  var totalShares = 0;
  for (const [emoji, reactions] of Object.entries(reactionsWithShares)) {
    reactionsWithShares[emoji].score = 0;
    for (const shares of reactions.shares) {
      reactionsWithShares[emoji].score += shares.shares;
      totalShares += shares.shares;
    }
  }

  console.log(JSON.stringify(reactionsWithShares, null, 2));
  console.log(totalShares)

  var winnerEmoji = null;
  var maxScore = 0;
  // Get the normalized scores and also get the winner emoji
  for (const [emoji, reactions] of Object.entries(reactionsWithShares)) {
    // Normalized scores are floats [0, 100], with 2 decimal places
    reactionsWithShares[emoji].normalizedScore = (
      (reactionsWithShares[emoji].score / totalShares) *
      100
    ).toFixed(3);
    // Get the emoji with highest score
    if (reactionsWithShares[emoji].score > maxScore) {
      maxScore = reactionsWithShares[emoji].score;
      winnerEmoji = emoji;
    }
  }

  console.log(JSON.stringify(reactionsWithShares, null, 2));
  console.log(winnerEmoji);
  console.log(maxScore);

  //console.log(`TOTAL SHARES: ${totalShares}`);

  return {winnerEmoji, reactionScores: reactionsWithShares}
}
module.exports = {
    config: {
        name: "checkers",
        aliases: ['checkerboard'],
        version: "1.0",
        author: "Sheikh",
        countDown: 5,
        role: 0,
        category: "game",
        guide: "This command allows you to play Checkers. The game board is represented by a 6x5 grid where players take turns to move their pieces. To make a move, reply with the position number (1-5) followed by 'left' or 'right'. For example, '2 left' or '4 right'. The game ends when one player captures all of the opponent's pieces or when there are no valid moves left.",
    },
    onStart: async function ({ event, message, api, usersData, args }) {
        const mention = Object.keys(event.mentions);
        if (args[0] == "close") {
            if (!global.game.hasOwnProperty(event.threadID) || global.game[event.threadID].on == false) { message.reply("There is no game running in this group") } else {
                if (event.senderID == global.game[event.threadID].player1.id || event.senderID == global.game[event.threadID].player2.id) {
                    if (event.senderID == global.game[event.threadID].player1.id) {
                        message.reply({ body: `What a cry baby. ${global.game[event.threadID].player1.name} left the game.\nWinner is ${global.game[event.threadID].player2.name}.`, mentions: [{ tag: global.game[event.threadID].player1.name, id: global.game[event.threadID].player1.id, }, { tag: global.game[event.threadID].player2.name, id: global.game[event.threadID].player2.id, }] })
                    } else {
                        message.reply({ body: `What a cry baby. ${global.game[event.threadID].player2.name} left the game.\nWinner is ${global.game[event.threadID].player1.name}.`, mentions: [{ tag: global.game[event.threadID].player1.name, id: global.game[event.threadID].player1.id, }, { tag: global.game[event.threadID].player2.name, id: global.game[event.threadID].player2.id, }] })
                    }
                    global.game[event.threadID].on = false
                } else {
                    message.reply("You don’t have any game running in this group")
                }
            }
        } else {
            if (mention.length == 0) return message.reply("Please mention someone or say game close to close any existing game");
            if (!global.game || !global.game.hasOwnProperty(event.threadID) || !global.game[event.threadID] || global.game[event.threadID].on === false) {
                if (!global.game) {
                    global.game = {};
                }
                global.game[event.threadID] = {
                    on: true,
                    board: "🔴⬛🔴⬛🔴\n⬛🔴⬛🔴⬛\n⬛⬛⬛⬛⬛\n⬛⬛⬛⬛⬛\n⬛🔵⬛🔵⬛\n🔵⬛🔵⬛🔵",
                    player1: { id: mention[0], name: await usersData.getName(mention[0]) },
                    player2: { id: event.senderID, name: await usersData.getName(event.senderID) },
                    turn: mention[0] // Starting player
                };
                message.send(global.game[event.threadID].board, (err, info) => { global.game[event.threadID].bid = info.messageID });
            } else {
                message.reply("A game is already on this group")
            }
        }
    },
    onChat: async function ({ event, message, api, args }) {
        if (event.type == "message_reply" && global.game[event.threadID] && global.game[event.threadID].on == true) {
            if (event.messageReply.messageID === global.game[event.threadID].bid) {
                if (global.game[event.threadID].turn === event.senderID) {
                    const move = event.body.toLowerCase();
                    const direction = move.split(" ")[1];
                    if (["left", "right"].includes(direction)) {
                        global.game[event.threadID].board = swapPieces(global.game[event.threadID].board, direction);
                        message.send(global.game[event.threadID].board);
                        global.game[event.threadID].turn = global.game[event.threadID].turn === global.game[event.threadID].player1.id ? global.game[event.threadID].player2.id : global.game[event.threadID].player1.id;
                    } else {
                        message.reply("Invalid move. Please specify 'left' or 'right' after the position number.");
                    }
                } else {
                    message.reply("Not your turn.");
                }
            } else {
                message.reply("Please reply with a valid move.");
            }
        }
    }
};

function swapPieces(board, direction) {
    const rows = board.split("\n");
    const numRows = rows.length;
    for (let i = 0; i < numRows; i++) {
        if (i % 2 === 0) { // Even rows (starting from 0)
            if (direction === "left") {
                rows[i] = rows[i].replace(/(🔴)(⬛)(🔴)(⬛)/g, "$2$1$2$1");
            } else if (direction === "right") {
                rows[i] = rows[i].replace(/(⬛)(🔴)(⬛)(🔴)/g, "$2$1$2$1");
            }
        } else { // Odd rows
            if (direction === "left") {
                rows[i] = rows[i].replace(/(⬛)(🔵)(⬛)(🔵)/g, "$2$1$2$1");
            } else if (direction === "right") {
                rows[i] = rows[i].replace(/(🔵)(⬛)(🔵)(⬛)/g, "$2$1$2$1");
            }
        }
    }
    return rows.join("\n");
}

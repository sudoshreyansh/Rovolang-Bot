import 'dotenv/config' 
import discord from 'discord.js'
import { SlashCommandBuilder } from '@discordjs/builders'
import { REST } from '@discordjs/rest'
import { Routes } from 'discord-api-types/v9'
import mysql from 'mysql2/promise'
let dbConnection

function logger(...messages) {
    const date = (new Date()).toLocaleString('en-GB', {timeZone: 'IST'}) + ':'
    console.log(date, ...messages)
}

async function checkForConnection() {
    if (!dbConnection || dbConnection?.connection?._closing) {
        dbConnection = await mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME
        })
        console.log('Database reconnected')
    }
}

async function fetchFlag(game, level) {
    const [flag, _] = await dbConnection.query('SELECT * FROM ?? WHERE chall=?', [game, level])
    if ( flag.length > 0 ) return flag[0].flag
    else return false
}

async function fetchUser(username) {
    const [users, _] = await dbConnection.query('SELECT * FROM scoreboard WHERE username=?', [username])
    if ( users.length > 0 ) return users[0]
    else {
        await dbConnection.query('INSERT IGNORE INTO scoreboard(username, unixit, oswap) VALUES(?, 0, 0)', [username])
        const [updatedUsers, _] = await dbConnection.query('SELECT * FROM scoreboard WHERE username=?', [username])
        return updatedUsers[0]
    }
}

async function updateUserScore(username, wargame, score) {
    await dbConnection.query('UPDATE scoreboard SET ?? = ? WHERE username=?', [wargame, score, username])
    return true
}

async function fetchScoreboard(wargame) {
    const [scores, _] = await dbConnection.query('SELECT username, ?? FROM scoreboard ORDER BY ?? DESC', [wargame, wargame])
    return scores
}

const MAX_LEVELS = {
    'oswap': 25,
    'unixit': 20
}

async function handleSubmitInteraction(interaction) {
    try {
        await interaction.deferReply({
            ephemeral: true
        })
        const username = interaction.member.user['username'] + "#" + interaction.member.user['discriminator'];
        const wargame = interaction.options.get('wargame').value
        const level = interaction.options.get('level').value
        const flag = interaction.options.get('flag').value
        const currentLevel = (await fetchUser(username))[wargame]

        if ( level === currentLevel && level <= MAX_LEVELS[wargame] ) {
            const correctFlag = await fetchFlag(wargame, level)
            if ( correctFlag === flag ) {
                await updateUserScore(username, wargame, level+1)

                if ( level < MAX_LEVELS[wargame] ) {
                    const channelName = `${wargame}-${level}`
                    const nextChannelName = `${wargame}-${level+1}`
                    const channels = await interaction.guild.channels.fetch()
                    
                    const currentChannel = channels.find(channel => channel.name === channelName)
                    const nextChannel = channels.find(channel => channel.name === nextChannelName)

                    await currentChannel.permissionOverwrites.edit(interaction.member.id, { VIEW_CHANNEL: false})
                    await nextChannel.permissionOverwrites.edit(interaction.member.id, { VIEW_CHANNEL: true})
                }

                logger(username, '-', wargame, '-', currentLevel, ' submitted correct flag')
                await interaction.editReply({
                    content: 'Amazing!'
                })
            } else {
                logger(username, '-', wargame, '-', currentLevel, ' submitted wrong flag, wrong:', flag, 'correct:', correctFlag)
                await interaction.editReply({
                    content: 'You need to work harder!'
                })
            }
        } else {
            logger(username, '-', wargame, '-', currentLevel, ' skipped to level', level)
            await interaction.editReply({
                content: 'Trying to time travel?'
            })
        }
    } catch ( e ) {
        logger('my back broke')
        console.log(e)
        await interaction.editReply({
            content: 'My back hurts!'
        })
    }
}

async function handleScoreboardInteraction(interaction) {
    try {
        await interaction.deferReply()
        const wargame = interaction.options.get('wargame').value
        const scores = await fetchScoreboard(wargame)
        const scoreboardName = ( wargame === 'unixit' ? 'UnixIT Scores' : 'OSWAP Scores' )

        const embed = new discord.MessageEmbed();
        embed.setColor("0x0099ff")   
        embed.setTitle(scoreboardName)

        for ( const score of scores ) {
            if ( score[wargame] !== 0 ) embed.addField(score.username, score[wargame].toString())
        }

        await interaction.editReply({
            embeds: [embed]
        })
    } catch ( e ) {
        logger('my back broke')
        console.log(e)
        await interaction.editReply({
            content: 'My back hurts!'
        })
    }
}

const commands = [
    new SlashCommandBuilder()
        .setName('submit')
        .setDescription('Submit your wargames flags')
        .addStringOption(option => (
            option
            .setName('wargame')
            .setDescription('The wargame you are submitting the flag for.')
            .setRequired(true)
            .addChoice('unixit', 'unixit')
            .addChoice('oswap', 'oswap')
        ))
        .addIntegerOption(option => (
            option
            .setName('level')
            .setDescription('The level of the wargame.')
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(25)
        ))
        .addStringOption(option => (
            option
            .setName('flag')
            .setDescription('Your flag')
            .setRequired(true)
        )),
    new SlashCommandBuilder()
        .setName('scoreboard')
        .setDescription(`View the scoreboard of wargames`)
        .addStringOption(option => (
            option
            .setName('wargame')
            .setDescription('The wargame you want the scoreboard for.')
            .setRequired(true)
            .addChoice('unixit', 'unixit')
            .addChoice('oswap', 'oswap')
        ))
        .setDefaultPermission(false)
].map(cmd => cmd.toJSON())

const interactionHandlers = {
    'submit': handleSubmitInteraction,
    'scoreboard': handleScoreboardInteraction
}

const interactionPermissions = {
    'scoreboard': [
        {
            id: process.env.ROOT_ID,
            type: 'ROLE',
            permission: true
        },
        {
            id: process.env.SYS_ADMIN_ID,
            type: 'ROLE',
            permission: true
        }
    ]
}

async function setup() {
    dbConnection = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    })
    console.log('Database connected')


    const rest = new REST({ version: '9' }).setToken(process.env.TOKEN)
    let previousCommands = await rest.get(
        Routes.applicationGuildCommands(process.env.ID, process.env.GUILD_ID)
    )
    let promises = [];
    for (const command of previousCommands) {
        const url = `${Routes.applicationGuildCommands(process.env.ID, process.env.GUILD_ID)}/${command.id}`;
        promises.push(rest.delete(url));
    }
    await Promise.all(promises);
    console.log('Deleted previous guild slash commands.')

    
    previousCommands = await rest.get(
        Routes.applicationCommands(process.env.ID, process.env.GUILD_ID)
    )
    promises = [];
    for (const command of previousCommands) {
        const url = `${Routes.applicationCommands(process.env.ID, process.env.GUILD_ID)}/${command.id}`;
        promises.push(rest.delete(url));
    }
    await Promise.all(promises);
    console.log('Deleted previous global slash commands.')


    await rest.put(
        Routes.applicationGuildCommands(process.env.ID, process.env.GUILD_ID),
        { body: commands }
    )
    console.log('Successfully registered slash commands.')

    
    const client = new discord.Client({
        intents: [discord.Intents.FLAGS.GUILDS]
    })

    client.once('ready', async () => {
        console.log('Bot ready')

        const guild = await client.guilds.fetch(process.env.GUILD_ID)
        const commands = await guild.commands.fetch()
        commands.each(async command => {
            if ( interactionPermissions[command.name] ) {
                await command.permissions.add({
                    permissions: interactionPermissions[command.name]
                })
            }
        })
        console.log('Set command permissions')
    })

    client.on('interactionCreate', async interaction => {
        if ( !interaction.isCommand() ) return
        const name = interaction.commandName

        for ( let handler in interactionHandlers ) {
            if ( handler === name ) {
                try {
                    await checkForConnection()
                    await interactionHandlers[handler](interaction)
                } catch ( e ) {
                    logger('someone attempted a murder :(')
                    console.log(e)
                    await interaction.reply({
                        content: 'Do you want to kill me?',
                        ephemeral: true
                    })
                }
                break
            }
        }
    })

    client.on('error', console.log)
    client.login(process.env.TOKEN)
}

setup().catch(console.log)
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  StringSelectMenuBuilder,
  ComponentType,
} = require("discord.js");
const { TICKET, EMBED_COLORS, EMOJI, PRESENCE } = require("@root/config.js");

// schemas
const { getSettings } = require("@schemas/Guild");

// helpers
const { postToBin } = require("@helpers/HttpUtils");
const { error } = require("@helpers/Logger");

const OPEN_PERMS = ["ManageChannels"];
const CLOSE_PERMS = ["ManageChannels", "ReadMessageHistory"];

/**
 * @param {import('discord.js').Channel} channel
 */
function isTicketChannel(channel) {
  return (
    channel.type === ChannelType.GuildText &&
    channel.name.startsWith("tіcket-") &&
    channel.topic &&
    channel.topic.startsWith("tіcket|")
  );
}

/**
 * @param {import('discord.js').Guild} guild
 */
function getTicketChannels(guild) {
  return guild.channels.cache.filter((ch) => isTicketChannel(ch));
}

/**
 * @param {import('discord.js').Guild} guild
 * @param {string} userId
 */
function getExistingTicketChannel(guild, userId) {
  const tktChannels = getTicketChannels(guild);
  return tktChannels.filter((ch) => ch.topic.split("|")[1] === userId).first();
}

/**
 * @param {import('discord.js').BaseGuildTextChannel} channel
 */
async function parseTicketDetails(channel) {
  if (!channel.topic) return;
  const split = channel.topic?.split("|");
  const userId = split[1];
  const catName = split[2] || "Default";
  const user = await channel.client.users.fetch(userId, { cache: false }).catch(() => {});
  return { user, catName };
}

/**
 * @param {import('discord.js').BaseGuildTextChannel} channel
 * @param {import('discord.js').User} closedBy
 * @param {string} [reason]
 */
async function closeTicket(channel, closedBy, reason) {
  if (!channel.deletable || !channel.permissionsFor(channel.guild.members.me).has(CLOSE_PERMS)) {
    return "MISSING_PERMISSIONS";
  }

  try {
    const config = await getSettings(channel.guild);
    const messages = await channel.messages.fetch();
    const reversed = Array.from(messages.values()).reverse();

    let content = "";
    reversed.forEach((m) => {
      content += `[${new Date(m.createdAt).toLocaleString("en-US")}] - ${m.author.username}\n`;
      if (m.cleanContent !== "") content += `${m.cleanContent}\n`;
      if (m.attachments.size > 0) content += `${m.attachments.map((att) => att.proxyURL).join(", ")}\n`;
      content += "\n";
    });

    const logsUrl = await postToBin(content, `Ticket Logs for ${channel.name}`);
    const ticketDetails = await parseTicketDetails(channel);

    const components = [];
    if (logsUrl) {
      components.push(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel("Transcript").setURL(logsUrl.short).setStyle(ButtonStyle.Link)
        )
      );
    }

    if (channel.deletable) await channel.delete();

    const embed = new EmbedBuilder().setAuthor({ name: `${EMOJI.INFO} Ticket Kapatıldı`}).setColor(EMBED_COLORS.BOT_EMBED);
    const fields = [];

    if (reason) fields.push({ name: "Sebep", value: reason, inline: false });
    fields.push(
      {
        name: "Açan",
        value: ticketDetails.user ? ticketDetails.user.username : "Bilinmiyor",
        inline: true,
      },
      {
        name: "Kapatan",
        value: closedBy ? closedBy.username : "Bilinmiyor",
        inline: true,
      }
    );

    embed.setFields(fields);

    // send embed to log channel
    if (config.ticket.log_channel) {
      const logChannel = channel.guild.channels.cache.get(config.ticket.log_channel);
      logChannel.safeSend({ embeds: [embed], components });
    }

    // send embed to user
    /*if (ticketDetails.user) {
      const dmEmbed = embed
        .setDescription(`**Server:** ${channel.guild.name}\n**Category:** ${ticketDetails.catName}`)
        .setThumbnail(channel.guild.iconURL());
      ticketDetails.user.send({ embeds: [dmEmbed], components }).catch((ex) => {});
    }*/

    return "SUCCESS";
  } catch (ex) {
    error("closeTicket", ex);
    return "ERROR";
  }
}

/**
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').User} author
 */
async function closeAllTickets(guild, author) {
  const channels = getTicketChannels(guild);
  let success = 0;
  let failed = 0;

  for (const ch of channels) {
    const status = await closeTicket(ch[1], author, "Force close all open tickets");
    if (status === "SUCCESS") success += 1;
    else failed += 1;
  }

  return [success, failed];
}

/**
 * @param {import("discord.js").ButtonInteraction} interaction
 */
async function handleTicketOpen(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const { guild, user } = interaction;

  if (!guild.members.me.permissions.has(OPEN_PERMS))
    return interaction.followUp(
      "Cannot create ticket channel, missing `Manage Channel` permission. Contact server manager for help!"
    );

  const already = new EmbedBuilder()
  .setColor(EMBED_COLORS.ERROR)
  .setTitle(`${EMOJI.WRONG} You already have an open ticket!`)
  .setDescription(`***Halihazırda açık bir biletiniz var.***`)
  .setFooter({text: PRESENCE.FOOTER, iconURL: interaction.client.user.avatarURL() })
  const alreadyExists = getExistingTicketChannel(guild, user.id);
  if (alreadyExists) return interaction.followUp({ embeds: [already], components: [] });

  const settings = await getSettings(guild);

  // limit check
  const limit = new EmbedBuilder()
  .setColor(EMBED_COLORS.ERROR)
  .setTitle(`${EMOJI.WRONG} There are too many open tickets, try again later!`)
  .setDescription(`***Bilet sistemimiz şuan aşırı yoğun, lütfen daha sonra tekrar deneyin.***`)
  .setFooter({text: PRESENCE.FOOTER, iconURL: interaction.client.user.avatarURL() })
  const existing = getTicketChannels(guild).size;
  if (existing > settings.ticket.limit) return interaction.followUp({ embeds: [limit], components: [] });

  // check categories
  let catName = null;
  let catPerms = [];
  const categories = settings.ticket.categories;
  if (categories.length > 0) {
    const options = [];
    settings.ticket.categories.forEach((cat) => options.push({ label: cat.name, value: cat.name }));
    const menuRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("ticket-menu")
        .setPlaceholder("Choose the ticket category / Bilet kategorisi seçin")
        .addOptions(options)
    );

    const category = new EmbedBuilder()
        .setColor(EMBED_COLORS.BOT_EMBED)
        .setTitle(`${EMOJI.LOADING} Please choose a ticket category!`)
        .setDescription(`***Lütfen bilet açmak istediğiniz kategoriyi seçin.***`)
        .setFooter({text: PRESENCE.FOOTER, iconURL: interaction.client.user.avatarURL() })

    await interaction.followUp({ embeds: [category], components: [menuRow] });
    const res = await interaction.channel
      .awaitMessageComponent({
        componentType: ComponentType.StringSelect,
        time: 60 * 1000,
      })
      .catch((err) => {
        if (err.message.includes("time")) return;
      });

      const timed = new EmbedBuilder()
        .setColor(EMBED_COLORS.ERROR)
        .setTitle(`${EMOJI.WRONG} Request timed out, try again!`)
        .setDescription(`***İstek zaman aşımına uğradı, tekrar deneyin.***`)
        .setFooter({text: PRESENCE.FOOTER, iconURL: interaction.client.user.avatarURL() })

      const processing = new EmbedBuilder()
        .setColor(EMBED_COLORS.BOT_EMBED)
        .setTitle(`${EMOJI.LOADING} Creating your ticket...`)
        .setDescription(`***Biletiniz oluşturuluyor...***`)
        .setFooter({text: PRESENCE.FOOTER, iconURL: interaction.client.user.avatarURL() })

    if (!res) return interaction.editReply({ embeds: [timed], components: [] });
    await interaction.editReply({ embeds: [processing], components: [] });
    catName = res.values[0];
    catPerms = categories.find((cat) => cat.name === catName)?.staff_roles || [];
  }

  try {
    const ticketNumber = (existing + 1).toString();
    const permissionOverwrites = [
      {
        id: guild.roles.everyone,
        deny: ["ViewChannel"],
      },
      {
        id: user.id,
        allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"],
      },
      {
        id: guild.members.me.roles.highest.id,
        allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"],
      },
    ];

    if (catPerms?.length > 0) {
      catPerms?.forEach((roleId) => {
        const role = guild.roles.cache.get(roleId);
        if (!role) return;
        permissionOverwrites.push({
          id: role,
          allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"],
        });
      });
    }

    const tktChannel = await guild.channels.create({
      name: `tіcket-${ticketNumber}`,
      type: ChannelType.GuildText,
      topic: `tіcket|${user.id}|${catName || "Default"}`,
      permissionOverwrites,
    });

    const embed = new EmbedBuilder()
        .setColor(EMBED_COLORS.BOT_EMBED)
        .setAuthor({ name: `Ticket for: ${interaction.user.tag} #${ticketNumber}`, iconURL: interaction.user.displayAvatarURL() }) 
        .setDescription(`> *Merhaba, bilet açtığınız için teşekkür ederiz. Personellerimiz sizinle ilgilenene kadar bilet açma sebebinizi açıklayabilirsiniz. Mesajlaşmalarınız kayıt altına alınmaktadır.*\n \n> *Hello, thank you for opening a ticket. You can explain the reason for opening a ticket until our staff can take care of you.*`)
        .setThumbnail(interaction.guild.iconURL())
      /*.setDescription(
        `Hello ${user.toString()}
        Support will be with you shortly
        ${catName ? `\n**Category:** ${catName}` : ""}
        `
      )*/
      
      const embed2 = new EmbedBuilder()
        .setColor(EMBED_COLORS.BOT_EMBED)
        .setAuthor({ name: `A staff member will claim this ticket soon!`, iconURL: `https://cdn.discordapp.com/emojis/833101350623117342.gif?size=512` }) 
        .setDescription(`> *Personellerimiz kısa süre içerisinde biletinize dönüş yapacak, lütfen sabırlı olun. Anlayışınız için teşekkür ederiz.*`)
        .setFooter({text: PRESENCE.FOOTER, iconURL: interaction.client.user.avatarURL() })
    let buttonsRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel("Close Ticket")
        .setCustomId("TICKET_CLOSE")
        .setEmoji("🔒")
        .setStyle(ButtonStyle.Danger)
    );

    const sent = await tktChannel.send({ content: user.toString(), embeds: [embed, embed2], components: [buttonsRow] });

   /*const dmEmbed = new EmbedBuilder()
      .setColor(EMBED_COLORS.BOT_EMBED)
      .setAuthor({ name: "Ticket Created" })
      .setThumbnail(guild.iconURL())
      .setDescription(
        `Bilet açtığınız için teşekkürler, kısa süre içinde kanal üzerinden sizinle iletişime geçeceğiz.
        **Server:** ${guild.name}
        ${catName ? `**Kategori:** ${catName}` : ""}
        `
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel("View Channel").setURL(sent.url).setStyle(ButtonStyle.Link)
    );

    user.send({ embeds: [dmEmbed], components: [row] }).catch((ex) => {});
*/
    const successfuly = new EmbedBuilder()
        .setColor(EMBED_COLORS.SUCCESS)
        .setTitle(`${EMOJI.CORRECT} Successfuly created your ticket!`)
        .setDescription(`***Biletiniz başarıyla oluşturuldu!***`)
        .setFooter({text: PRESENCE.FOOTER, iconURL: interaction.client.user.avatarURL() })

    await interaction.editReply({ embeds: [successfuly], components: [] });
  } catch (ex) {
    error("handleTicketOpen", ex);
    const unsuccessfuly = new EmbedBuilder()
        .setColor(EMBED_COLORS.ERROR)
        .setTitle(`${EMOJI.ERROR} An error has occurred while creating your ticket!`)
        .setDescription(`***Biletiniz oluşturulurken bir hata oluştu!***`)
        .setFooter({text: PRESENCE.FOOTER, iconURL: interaction.client.user.avatarURL() })
    return interaction.editReply({ embeds: [unsuccessfuly], components: [] });
  }
}

/**
 * @param {import("discord.js").ButtonInteraction} interaction
 */
async function handleTicketClose(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const status = await closeTicket(interaction.channel, interaction.user);
  if (status === "MISSING_PERMISSIONS") {
    return interaction.followUp("Cannot close the ticket, missing permissions. Contact server manager for help!");
  } else if (status == "ERROR") {
    return interaction.followUp("Failed to close the ticket, an error occurred!");
  }
}

module.exports = {
  getTicketChannels,
  getExistingTicketChannel,
  isTicketChannel,
  closeTicket,
  closeAllTickets,
  handleTicketOpen,
  handleTicketClose,
};

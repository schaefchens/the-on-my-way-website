/**
 * About 1002 common passwords and password words (lower case; English and German lists, names,
 * clubs, keyboard walks, travel words), for the strength hint of the password change (§7.8).
 * Loaded as a lazy chunk when the sheet opens; never a rule, only a hint.
 */
const WORDS = `
0000 000000 0987654321 101010 102030 1029384756 1111 11111 111111 11111111 112233 11223344 1122334455
112233445566 112358 121212 12121212 123123 123123123 123123123123 123321 1234 12344321 12345 123454321
1234554321 123456 1234567 12345678 123456789 1234567890 1234567a 1234abcd 1234qwer 1234qwerasdf 123654 123789
123abc 123qwe 123qweasd 131313 135790 147258 147258369 147852369 1478963 159357 159753 1a2b3c4d 1q2w3e
1q2w3e4 1q2w3e4r 1q2w3e4r5t 1qaz 1qaz2wsx 1qaz2wsx3edc 1qazxsw2 1qw23e 2000 202020 222222 232323 246810 2wsx
333333 3edc 456789 555555 654321 666666 696969 741852963 777777 7777777 789456 789456123 87654321 888888
88888888 951753 963852741 987654 987654321 9876543210 999999 a123456 a1234567 a1b2c3 a3 aa123456 aaaaaa
aaaaaaaa aaron abc123 abc1234 abc12345 abc123456 abc123abc abcabc abcd1234 abcdef abcdefg abcdefgh abenteuer
abigail access adam adidas admin admin123 admin1234 administrator adventure afrika alan albert alexander
alexandra alexis alice amanda amber amerika amy andrea andreas andrew angel angel1 angela anmelden ann anna
anthony anything april aroundtheworld arsenal arsenalfc arthur asd123 asdasd asdf asdf123 asdf1234 asdfasdf
asdfg asdfgh asdfgh123 asdfghjk asdfghjkl asdfghjkl1 ashley asien astra audi august austin australien autumn
baby babygirl backpacker backpacking badboy baer baerchen bailey bali banana barbara barcelona barchen barney
baseball baseball1 baseball123 basketball batman batman1 batman123 bayern bayern1 bear beatles ben benjamin
benutzer berlin bernd bestfriend betty beverly beyonce bigdaddy bigdog billy biteme bitte black blue blume
blumen bmw320 bobby booboo boomer borussia boston brandon brandy brenda brian brittany bruce bruder bryan
bulldog bunny buster butterfly bvb09 camaro carina carl carol carolyn casper catherine changeit changeme
charles charlie charlie123 charlotte cheese chelsea chelseafc cheryl chester chicago chicken china chocolate
chris christian christina christine christopher clara claudia cocacola coffee compaq computer cookie corsa
corvette cowboy cowboys crystal cupcake cynthia dakota dallas dance daniel daniela danielle danke dankeschoen
darling david deborah debra december default demo demo123 denise dennis deutschland diablo diamond diana
diane dieter dirk doggy dolphin donald donna doris dorothy dortmund dortmund1 douglas dragon dragon1
dragon123 dresden dylan eagle eagles edcrfv edward einloggen eintracht elias elijah elizabeth emil emily
eminem emma engel engelchen enter eric erich ethan eugene europa evelyn everything explore explorer falcon
familie family fcbayern february felix fender fernweh ferrari ferrari1 finn fishing florian flower football
football1 football123 forever fortnite frances frank frankfurt frankfurt1 frankreich franziska freedom
freiheit freunde freundin friday frieda friend friends fritz frodo fruehling fruehling2026 fruhling fussball
fussball1 gabriel gameover gandalf gary gateway geheim geheim123 george gerald gerhard germany gfhjkm ginger
gladbach gloria golden golf golf1 golfer gollum grace green gregory greta griechenland gryffindor guenter
guest guest123 guitar gunter gutenacht gutenmorgen hallo hallo1 hallo123 hallo2026 hallowelt hamburg hamburg1
hammer hannah hannover hans happy harley harold harrypotter heather heimat heinz helen helena hello hello1
hello123 hello1234 hellohello helloworld helmut henry herbert herbst herbst2026 hertha hobbit hockey hogwarts
holger holiday holidays honey horse horst hsv1887 hulk hund hunde hunter hunter123 iceman ichliebedich ida
iloveu iloveyou iloveyou1 iloveyou123 iloveyou2 indien inter internet ironman isabel isabella italien jack
jackson jacob jacqueline james jan jana janet janice january japan jasmine jason jasper jean jedi jeffrey
jennifer jennifer123 jeremy jerry jesse jessica joachim joan joe johanna john johnny jonas jonathan jordan
jordan123 jose joseph joshua journey joyce juan judith judy juergen julia julian julie july june junior
jurgen justin justinbieber juventus kaiserslautern kanada karen karl katharina katherine kathleen kathrin
kathryn katze katzen kayla keith kelly kenneth kennwort kennwort1 kevin killer killer1 killer123 kimberly
kinder kitten kitty klaster klaus knight koeln koln kurt kyle lakers lara larry laura lauren lawrence lea
leipzig lena leon leonie letmein letmein1 letmein123 letmeinnow liebe lina linda lion lisa liverpool logan
login london lori louis love love2026 lovely loveme lovers loveyou loveyou123 luca lukas madison madonna
maggie mallorca mama manchester manfred marcel march margaret maria marie marilyn marina marine mario mark
markus marlboro martha martin marvel mary mason master master1 master123 matrix matthew matthias maus mausi
maverick maximilian may megan melanie melissa mercedes mercedes1 merlin metallica mia michael michael123
michelle mickey midnight milan miller minecraft minecraft1 miriam moin moinmoin monday money monika monkey
monkey1 monkey123 monster morgan moritz mother muenchen munchen music mustang mustang1 mutti mypassword
mysecret myself nancy naruto naruto1 nascar natalie natasha nathan ncc1701 neuseeland newpassword nicholas
nicole nikita niklas nina nintendo nirvana noah norbert nothing november nuernberg nurnberg october oliver
olivia oma onedirection onmyway onmyway2026 opa opensesame orange otto p4ssword pa55word pamela panda papa
pass pass123 pass1234 passat passport passw0rd password password01 password1 password12 password123
password12345 password2 password2026 passwort passwort1 passwort123 passwort2026 patricia patrick paul paula
peanut pepper persoenlich peter petra philip philipp phoenix piano pikachu pink player playstation please
pokemon pokemon1 polo pony porsche porsche1 portugal prince princess princess1 princess123 privat private
prost puppy purple q1w2e3 q1w2e3r4 q1w2e3r4t5 qazwsx qazwsxedc qazxsw queen qwe123 qweasdzxc qweqwe qwer1234
qwerasdf qwert qwerty qwerty1 qwerty12 qwerty123 qwerty1234 qwerty12345 qwertyu qwertyuiop qwertyuiop1
qwertyuiopasdf qwertz qwertz123 qwertzuiop rabbit rachel raiders rainbow rainer ralf ralph randy ranger
rangers raymond realmadrid rebecca red redsox reise reise2026 reisen reisetagebuch richard rihanna roadtrip
robert rockstar roger ronald root root123 roy russell ruth ryan sabine samantha samsung samuel sandra sara
sarah saturday schalke schalke04 schalke1 schatz schatz123 schatzi schwester scooby scooter scott sean
sebastian secret secretpassword september servus shadow shadow1 shadow123 shakira sharon shirley sicher
sicherheit sicherheit123 silver simon singer skate skywalker slayer slytherin smile smokey snoopy soccer sohn
something sommer sommer2024 sommer2025 sommer2026 sonic sonne sonnenschein sophia sophie spanien spanky
sparky spider spiderman spring spring2026 starwars starwars1 steelers stefan stefanie stephanie stephen
steven stpauli stuttgart summer summer2024 summer2025 summer2026 sunday sunshine sunshine1 sunshine123
superman superman1 superman123 supersecret superstar surfing susan susanne sven sweetheart sweetie sweety
tanja taylor temp temppassword tennis teresa terry test test123 test1234 testtest thailand theresa thomas
thor thunder thursday tiger tigers tigger tim timothy tobias tochter together tom topsecret travel travel2026
traveler traveljournal traveller trustme trustno1 tschuess tschuss tuerkei tuesday turkei turtle tyler
unicorn unionberlin urlaub user user123 uwe vacation vader vanessa vati victoria vietnam vietnam2026 vincent
virginia walter wanderlust wayne wednesday welcome welcome1 welcome123 welcome2026 weltreise werder
werderbremen werner whatever whatever1 white william willie winner winter winter2024 winter2025 winter2026
wizard wolf wolfgang worldtrip wsxedc xbox xxxxxx yamaha yankees yellow yoda yourpassword yourself yxcvbnm
zachary zaq12wsx zelda zugang zugang123 zuhause zxc123 zxcv1234 zxcvb zxcvbn zxcvbnm zxcvbnm1 zxcvbnm123
zxczxc
`;

export const COMMON_PASSWORDS: ReadonlySet<string> = new Set(WORDS.split(/\s+/).filter(Boolean));
